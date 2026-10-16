'use strict';

const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');

const Fisherman = require('../fishermen/fisherman.model');
const Boat = require('../assets/boat.model');
const Engine = require('../assets/engine.model');
const Allocation = require('../programmes/allocation.model');
const Community = require('../communities/community.model');

const dashboardService = require('../dashboard/dashboard.service');
const auditService = require('../../services/audit.service');
const ApiError = require('../../utils/ApiError');
const { buildScopeFilter, assertCanAccessLga } = require('../../middleware/authorize');
const { LGA_BY_CODE, AUDIT_ACTIONS, ALLOCATION_STATUS } = require('../../config/constants');

/**
 * Report generation in PDF, Excel and CSV (concept note §7).
 *
 * Two decisions worth noting:
 *
 * 1. EXPORTS ARE STREAMED. A state-wide register export is tens of thousands
 *    of rows; building it in memory would risk the process under a handful of
 *    concurrent requests. Rows are cursored out of Mongo and written to the
 *    response as they arrive.
 *
 * 2. EXPORTS ARE AUDITED. An export removes personal data from the system's
 *    control, so every one is recorded with the filters used and the row
 *    count — the audit trail should be able to answer "who took a copy of the
 *    Bakassi register, and when".
 */

const MAX_EXPORT_ROWS = 100_000;

/** Columns shared by the register exports. */
const REGISTER_COLUMNS = [
  { header: 'Blue ID', key: 'blueId', width: 20 },
  { header: 'Full Name', key: 'fullName', width: 28 },
  { header: 'Gender', key: 'gender', width: 10 },
  { header: 'Year of Birth', key: 'birthYear', width: 14 },
  { header: 'Phone', key: 'phone', width: 16 },
  { header: 'LGA', key: 'lgaName', width: 20 },
  { header: 'Community', key: 'communityName', width: 22 },
  { header: 'Landing Site', key: 'landingSite', width: 22 },
  { header: 'Fisherman Type', key: 'fishermanTypes', width: 26 },
  { header: 'Fishing Type', key: 'fishingTypes', width: 22 },
  { header: 'Years Fishing', key: 'yearsFishing', width: 14 },
  { header: 'Cooperative', key: 'cooperativeName', width: 24 },
  { header: 'Status', key: 'status', width: 22 },
  { header: 'Registered On', key: 'registeredAt', width: 18 },
];

function buildRegisterFilter(query, actor) {
  const filter = {
    ...buildScopeFilter(actor, { ownerField: null, cooperativeField: null }),
    isDeleted: { $ne: true },
  };
  if (query.lga) {
    assertCanAccessLga(actor, query.lga);
    filter.lga = query.lga;
  }
  if (query.community) filter.community = query.community;
  if (query.status) filter.status = query.status;
  if (query.gender) filter.gender = query.gender;
  if (query.fishermanType) filter.fishermanTypes = query.fishermanType;
  if (query.hasBlueId === true) filter.blueId = { $exists: true, $ne: null };
  if (query.from || query.to) {
    filter.createdAt = {};
    if (query.from) filter.createdAt.$gte = query.from;
    if (query.to) filter.createdAt.$lte = query.to;
  }
  return filter;
}

/** Flattens a register document into a single export row. */
function toRegisterRow(doc) {
  return {
    blueId: doc.blueId || '',
    fullName: doc.fullName || '',
    gender: doc.gender || '',
    birthYear: doc.match?.birthYear || (doc.dateOfBirth ? new Date(doc.dateOfBirth).getFullYear() : ''),
    // The raw phone is included: these exports go to the ministry for
    // outreach. NIN is deliberately never exported.
    phone: doc.phone || '',
    lgaName: LGA_BY_CODE[doc.lga]?.name || doc.lga || '',
    communityName: doc.communityName || '',
    landingSite: doc.landingSite || '',
    fishermanTypes: (doc.fishermanTypes || []).join(', '),
    fishingTypes: (doc.fishingTypes || []).join(', '),
    yearsFishing: doc.yearsFishing ?? '',
    cooperativeName: doc.cooperative?.name || '',
    status: doc.status || '',
    registeredAt: doc.createdAt ? new Date(doc.createdAt).toISOString().slice(0, 10) : '',
  };
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/**
 * Escapes a CSV cell.
 *
 * The leading-apostrophe guard on =, +, - and @ is deliberate: these files are
 * opened in Excel by ministry staff, and a value beginning with one of those
 * characters would otherwise be interpreted as a formula.
 */
function csvCell(value) {
  const str = value == null ? '' : String(value);
  const needsGuard = /^[=+\-@\t\r]/.test(str);
  const guarded = needsGuard ? `'${str}` : str;
  return /[",\n\r]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

async function streamRegisterCsv(query, actor, res, options = {}) {
  const filter = buildRegisterFilter(query, actor);
  const filename = `blue-id-register-${query.lga || 'all'}-${stamp()}.csv`;

  res.setHeader('content-type', 'text/csv; charset=utf-8');
  res.setHeader('content-disposition', `attachment; filename="${filename}"`);

  // BOM so Excel reads UTF-8 names correctly.
  res.write('﻿');
  res.write(`${REGISTER_COLUMNS.map((c) => csvCell(c.header)).join(',')}\n`);

  let rows = 0;
  const cursor = Fisherman.find(filter).sort({ lga: 1, createdAt: 1 }).lean().cursor();

  for await (const doc of cursor) {
    const row = toRegisterRow(doc);
    res.write(`${REGISTER_COLUMNS.map((c) => csvCell(row[c.key])).join(',')}\n`);
    rows += 1;
    if (rows >= MAX_EXPORT_ROWS) break;
  }

  res.end();
  await recordExport('CSV', 'register', filter, rows, options.req);
  return rows;
}

// ---------------------------------------------------------------------------
// Excel
// ---------------------------------------------------------------------------

async function streamRegisterExcel(query, actor, res, options = {}) {
  const filter = buildRegisterFilter(query, actor);
  const filename = `blue-id-register-${query.lga || 'all'}-${stamp()}.xlsx`;

  res.setHeader(
    'content-type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
  res.setHeader('content-disposition', `attachment; filename="${filename}"`);

  // The streaming writer keeps memory flat regardless of row count.
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res, useStyles: true });
  workbook.creator = 'Cross River State Blue Economy — Blue ID';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('Register', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  sheet.columns = REGISTER_COLUMNS;
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getRow(1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF0B4F6C' },
  };
  sheet.getRow(1).commit();

  let rows = 0;
  const cursor = Fisherman.find(filter).sort({ lga: 1, createdAt: 1 }).lean().cursor();

  for await (const doc of cursor) {
    sheet.addRow(toRegisterRow(doc)).commit();
    rows += 1;
    if (rows >= MAX_EXPORT_ROWS) break;
  }
  sheet.commit();

  // A summary tab so the file is self-describing when it is passed around.
  const meta = workbook.addWorksheet('About');
  meta.columns = [
    { header: 'Field', key: 'field', width: 26 },
    { header: 'Value', key: 'value', width: 50 },
  ];
  meta.addRow({ field: 'Report', value: 'Blue ID Fishermen Register' }).commit();
  meta.addRow({ field: 'Generated', value: new Date().toISOString() }).commit();
  meta.addRow({ field: 'Generated by', value: `${actor.fullName} (${actor.role})` }).commit();
  meta.addRow({ field: 'Local Government Area', value: query.lga || 'All (within scope)' }).commit();
  meta.addRow({ field: 'Records', value: rows }).commit();
  meta.addRow({
    field: 'Confidentiality',
    value: 'Contains personal data. Handle under the applicable data protection rules.',
  }).commit();
  meta.commit();

  await workbook.commit();
  await recordExport('EXCEL', 'register', filter, rows, options.req);
  return rows;
}

/** Multi-sheet statistical workbook for the ministry. */
async function streamStatisticsExcel(query, actor, res, options = {}) {
  const filename = `blue-id-statistics-${stamp()}.xlsx`;
  res.setHeader(
    'content-type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
  res.setHeader('content-disposition', `attachment; filename="${filename}"`);

  const [summary, communities, capacity, gaps] = await Promise.all([
    dashboardService.summary(query, actor),
    dashboardService.byCommunity(query, actor),
    dashboardService.capacityByLga(query, actor),
    dashboardService.infrastructureGaps(query, actor),
  ]);

  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res, useStyles: true });

  const addSheet = (name, columns, rows) => {
    const sheet = workbook.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
    sheet.columns = columns;
    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).commit();
    for (const row of rows) sheet.addRow(row).commit();
    sheet.commit();
  };

  addSheet(
    'Summary',
    [
      { header: 'Indicator', key: 'indicator', width: 40 },
      { header: 'Value', key: 'value', width: 18 },
    ],
    [
      { indicator: 'Total registered fishermen', value: summary.fishermen.total },
      { indicator: 'Verified (Blue ID issued)', value: summary.fishermen.verified },
      { indicator: 'Awaiting verification', value: summary.fishermen.awaitingVerification },
      { indicator: 'Under duplicate review', value: summary.fishermen.underDuplicateReview },
      { indicator: 'Male', value: summary.fishermen.byGender.MALE || 0 },
      { indicator: 'Female', value: summary.fishermen.byGender.FEMALE || 0 },
      { indicator: 'Boat owners', value: summary.highlights.boatOwners },
      { indicator: 'Fish farmers', value: summary.highlights.fishFarmers },
      { indicator: 'Fish processors', value: summary.highlights.fishProcessors },
      { indicator: 'Cooperative members', value: summary.highlights.cooperativeMembers },
      { indicator: 'Registered boats', value: summary.assets.boats },
      { indicator: 'Registered outboard engines', value: summary.assets.outboardEngines },
      { indicator: 'Interventions delivered', value: summary.interventions.delivered },
      { indicator: 'Unique beneficiaries', value: summary.interventions.uniqueBeneficiaries },
    ]
  );

  addSheet(
    'By Community',
    [
      { header: 'Community', key: 'community', width: 28 },
      { header: 'LGA', key: 'lgaName', width: 22 },
      { header: 'Fishermen', key: 'fishermen', width: 12 },
      { header: 'Male', key: 'male', width: 10 },
      { header: 'Female', key: 'female', width: 10 },
      { header: 'Verified', key: 'verified', width: 12 },
      { header: 'Boat Owners', key: 'boatOwners', width: 14 },
      { header: 'Boats', key: 'boats', width: 10 },
    ],
    communities
  );

  addSheet(
    'Capacity by LGA',
    [
      { header: 'LGA', key: 'name', width: 24 },
      { header: 'Zone', key: 'zone', width: 12 },
      { header: 'Fishermen', key: 'fishermen', width: 12 },
      { header: 'Verified', key: 'verified', width: 12 },
      { header: 'Boats', key: 'boats', width: 10 },
      { header: 'Engines', key: 'engines', width: 10 },
      { header: 'Total HP', key: 'totalHorsepower', width: 12 },
      { header: 'Est. Monthly Catch (kg)', key: 'estimatedMonthlyCatchKg', width: 22 },
    ],
    capacity
  );

  addSheet(
    'Infrastructure Gaps',
    [
      { header: 'Community', key: 'name', width: 28 },
      { header: 'LGA', key: 'lgaName', width: 22 },
      { header: 'Missing Facility', key: 'facility', width: 24 },
      { header: 'Registered Fishermen', key: 'registeredFishermen', width: 20 },
    ],
    Object.entries(gaps.lacking).flatMap(([facility, list]) =>
      list.map((c) => ({ ...c, facility }))
    )
  );

  await workbook.commit();
  await recordExport('EXCEL', 'statistics', query, communities.length, options.req);
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

const BRAND = '#0B4F6C';

/** Executive summary PDF for circulation inside the ministry. */
async function streamSummaryPdf(query, actor, res, options = {}) {
  const summary = await dashboardService.summary(query, actor);
  const capacity = await dashboardService.capacityByLga(query, actor);

  const filename = `blue-id-summary-${stamp()}.pdf`;
  res.setHeader('content-type', 'application/pdf');
  res.setHeader('content-disposition', `attachment; filename="${filename}"`);

  const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true });
  doc.pipe(res);

  doc.rect(0, 0, doc.page.width, 90).fill(BRAND);
  doc.fillColor('#FFFFFF').fontSize(18).text('Cross River State Blue Economy', 50, 30);
  doc.fontSize(11).text('Blue ID & Fisheries Information Management System', 50, 54);
  doc.fillColor('#000000');
  doc.moveDown(4);

  doc.fontSize(15).text('Executive Summary', { underline: false });
  doc.fontSize(9).fillColor('#555555')
    .text(
      `Generated ${new Date().toLocaleString('en-NG')} by ${actor.fullName} (${actor.role})` +
        (query.lga ? ` — ${LGA_BY_CODE[query.lga]?.name}` : ' — State-wide')
    );
  doc.fillColor('#000000').moveDown(1);

  const tiles = [
    ['Registered fishermen', summary.fishermen.total],
    ['Blue IDs issued', summary.fishermen.verified],
    ['Awaiting verification', summary.fishermen.awaitingVerification],
    ['Under duplicate review', summary.fishermen.underDuplicateReview],
    ['Registered boats', summary.assets.boats],
    ['Outboard engines', summary.assets.outboardEngines],
    ['Cooperative members', summary.highlights.cooperativeMembers],
    ['Interventions delivered', summary.interventions.delivered],
  ];

  let x = 50;
  let y = doc.y;
  tiles.forEach(([label, value], i) => {
    if (i > 0 && i % 2 === 0) {
      y += 54;
      x = 50;
    }
    doc.roundedRect(x, y, 240, 44, 4).fillAndStroke('#F3F6F8', '#DDE5EA');
    doc.fillColor(BRAND).fontSize(16).text(String(value ?? 0), x + 12, y + 8);
    doc.fillColor('#445').fontSize(8).text(label.toUpperCase(), x + 12, y + 29);
    x += 255;
  });

  doc.fillColor('#000000').y = y + 70;
  doc.moveDown(1);
  doc.fontSize(12).text('Fisheries capacity by Local Government Area');
  doc.moveDown(0.5);

  // Table
  const cols = [
    { label: 'LGA', width: 120, key: 'name' },
    { label: 'Fishermen', width: 70, key: 'fishermen' },
    { label: 'Verified', width: 60, key: 'verified' },
    { label: 'Boats', width: 55, key: 'boats' },
    { label: 'Engines', width: 60, key: 'engines' },
    { label: 'Total HP', width: 65, key: 'totalHorsepower' },
  ];

  const drawRow = (values, { bold = false, fill = null } = {}) => {
    const rowY = doc.y;
    if (fill) doc.rect(50, rowY - 2, 430, 16).fill(fill);
    let cx = 50;
    doc.fillColor(bold ? '#FFFFFF' : '#000000').fontSize(8);
    cols.forEach((c, i) => {
      doc.text(String(values[i] ?? ''), cx + 4, rowY + 2, { width: c.width - 8, ellipsis: true });
      cx += c.width;
    });
    doc.fillColor('#000000');
    doc.y = rowY + 16;
  };

  drawRow(cols.map((c) => c.label), { bold: true, fill: BRAND });
  capacity
    .filter((row) => row.fishermen > 0 || row.waterfront)
    .forEach((row, i) => {
      if (doc.y > doc.page.height - 80) {
        doc.addPage();
        drawRow(cols.map((c) => c.label), { bold: true, fill: BRAND });
      }
      drawRow(cols.map((c) => row[c.key]), { fill: i % 2 ? '#F7F9FA' : null });
    });

  // Page numbers and a confidentiality footer on every page.
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i += 1) {
    doc.switchToPage(i);
    doc.fontSize(7).fillColor('#777777')
      .text(
        `Contains personal data — handle in line with applicable data protection rules.    Page ${i + 1} of ${range.count}`,
        50,
        doc.page.height - 40,
        { width: doc.page.width - 100, align: 'center' }
      );
  }

  doc.end();
  await recordExport('PDF', 'summary', query, summary.fishermen.total, options.req);
}

/**
 * Beneficiary list for one programme — the document a distribution exercise
 * is run from, and the record of who was paid or issued what.
 */
async function streamBeneficiariesCsv(programmeId, query, actor, res, options = {}) {
  const filter = {
    programme: programmeId,
    isDeleted: { $ne: true },
    ...buildScopeFilter(actor, { ownerField: null, cooperativeField: null }),
  };
  if (query.status) filter.status = query.status;

  const filename = `beneficiaries-${programmeId}-${stamp()}.csv`;
  res.setHeader('content-type', 'text/csv; charset=utf-8');
  res.setHeader('content-disposition', `attachment; filename="${filename}"`);

  const columns = [
    'Blue ID',
    'Beneficiary',
    'LGA',
    'Item',
    'Quantity',
    'Value',
    'Status',
    'Allocated On',
    'Delivered On',
  ];
  res.write('﻿');
  res.write(`${columns.map(csvCell).join(',')}\n`);

  let rows = 0;
  const cursor = Allocation.find(filter).sort({ lga: 1, fishermanName: 1 }).lean().cursor();

  for await (const a of cursor) {
    res.write(
      [
        a.blueId,
        a.fishermanName,
        LGA_BY_CODE[a.lga]?.name || a.lga,
        a.itemDescription,
        a.quantity,
        a.value,
        a.status,
        a.allocatedAt ? new Date(a.allocatedAt).toISOString().slice(0, 10) : '',
        a.deliveredAt ? new Date(a.deliveredAt).toISOString().slice(0, 10) : '',
      ]
        .map(csvCell)
        .join(',')
    );
    res.write('\n');
    rows += 1;
  }

  res.end();
  await recordExport('CSV', 'beneficiaries', filter, rows, options.req);
  return rows;
}

/** Boat and engine register export. */
async function streamAssetsCsv(kind, query, actor, res, options = {}) {
  const Model = kind === 'ENGINE' ? Engine : Boat;
  const filter = {
    ...buildScopeFilter(actor, { ownerField: null, cooperativeField: null }),
    isDeleted: { $ne: true },
  };
  if (query.lga) {
    assertCanAccessLga(actor, query.lga);
    filter.lga = query.lga;
  }

  const filename = `${kind.toLowerCase()}-register-${stamp()}.csv`;
  res.setHeader('content-type', 'text/csv; charset=utf-8');
  res.setHeader('content-disposition', `attachment; filename="${filename}"`);

  const columns =
    kind === 'ENGINE'
      ? ['Blue ID', 'Owner', 'LGA', 'Manufacturer', 'Model', 'Horsepower', 'Serial Number', 'Condition', 'Source']
      : ['Blue ID', 'Owner', 'LGA', 'Registration No.', 'Boat Type', 'Length (m)', 'Propulsion', 'Condition', 'Source'];

  res.write('﻿');
  res.write(`${columns.map(csvCell).join(',')}\n`);

  let rows = 0;
  const cursor = Model.find(filter)
    .populate('owner', 'fullName')
    .sort({ lga: 1 })
    .lean()
    .cursor();

  for await (const a of cursor) {
    const values =
      kind === 'ENGINE'
        ? [a.blueId, a.owner?.fullName, LGA_BY_CODE[a.lga]?.name || a.lga, a.manufacturer, a.model, a.horsepower, a.serialNumber, a.condition, a.acquisitionSource]
        : [a.blueId, a.owner?.fullName, LGA_BY_CODE[a.lga]?.name || a.lga, a.registrationNumber, a.boatType, a.lengthMeters, a.propulsion, a.condition, a.acquisitionSource];
    res.write(`${values.map(csvCell).join(',')}\n`);
    rows += 1;
  }

  res.end();
  await recordExport('CSV', `${kind.toLowerCase()}-register`, filter, rows, options.req);
  return rows;
}

async function recordExport(format, report, filters, rowCount, req) {
  await auditService.record({
    action: AUDIT_ACTIONS.EXPORT,
    entity: { type: 'Report', label: `${report} (${format})` },
    metadata: { format, report, rowCount, filters: sanitiseFilters(filters) },
    req,
  });
}

/** Strips Mongo operators so the audit metadata stays readable. */
function sanitiseFilters(filters) {
  try {
    return JSON.parse(JSON.stringify(filters));
  } catch {
    return {};
  }
}

const stamp = () => new Date().toISOString().slice(0, 10);

module.exports = {
  streamRegisterCsv,
  streamRegisterExcel,
  streamStatisticsExcel,
  streamSummaryPdf,
  streamBeneficiariesCsv,
  streamAssetsCsv,
  MAX_EXPORT_ROWS,
};
