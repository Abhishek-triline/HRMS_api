/**
 * Payslip PDF renderer — Phase 4.
 *
 * PDF library: pdfkit (chosen over @react-pdf/renderer for the following reasons):
 *   1. pdfkit has zero build-step dependencies — works natively in Node.js ESM.
 *   2. @react-pdf/renderer requires a JSX transform + React runtime in the API
 *      server; pdfkit does not. This keeps the API bundle simple.
 *   3. pdfkit streams directly to res (piping), matching the route's streaming
 *      response pattern.
 *
 * Visual reference: prototype/employee/payslip.html
 * Branding: Nexora HRMS header, employee details grid, earnings/deductions tables,
 * big Net Pay panel, footer note.
 */

import PDFDocument from 'pdfkit';
import type { Response } from 'express';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PayslipPDFData {
  // Payslip fields
  code: string;
  month: number;
  year: number;
  status: string;
  periodStart: string;   // YYYY-MM-DD
  periodEnd: string;     // YYYY-MM-DD
  workingDays: number;
  daysWorked: number;
  lopDays: number;
  basicPaise: number;
  allowancesPaise: number;
  grossPaise: number;
  lopDeductionPaise: number;
  referenceTaxPaise: number;
  finalTaxPaise: number;
  otherDeductionsPaise: number;
  netPayPaise: number;
  finalisedAt: string | null;
  reversalOfPayslipId: string | null;
  // Employee fields
  employeeName: string;
  employeeCode: string;
  designation: string | null;
  department: string | null;
  runCode: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Convert integer paise to a formatted rupee string e.g. "₹1,23,456.78" */
function formatPaise(paise: number): string {
  const rupees = paise / 100;
  // Use Indian numbering system (lakh/crore separators)
  return '₹' + rupees.toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

const MONTH_NAMES = [
  '', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// ── PDF builder ───────────────────────────────────────────────────────────────

/**
 * Stream a payslip PDF to the Express response.
 * Sets Content-Type and Content-Disposition before piping.
 */
export function streamPayslipPDF(data: PayslipPDFData, res: Response): void {
  const doc = new PDFDocument({ margin: 40, size: 'A4' });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${data.code}.pdf"`,
  );

  doc.pipe(res);

  const PAGE_W = 595 - 80; // A4 width minus margins (2×40)
  const FOREST = '#1E4D2B';
  const CHARCOAL = '#1A1D23';
  const SLATE = '#5E6672';
  const MINT = '#4CC68D';
  const OFFWHITE = '#F7F8FA';
  const SAGE = '#A8B5A0';

  // ── Header band ──────────────────────────────────────────────────────────────
  doc.rect(0, 0, 595, 70).fill(FOREST);

  doc
    .font('Helvetica-Bold')
    .fontSize(18)
    .fillColor('#FFFFFF')
    .text('Nexora HRMS', 40, 20);

  doc
    .font('Helvetica')
    .fontSize(9)
    .fillColor('#FFFFFF')
    .opacity(0.7)
    .text('Confidential — Employee Payslip', 40, 42);

  // Status badge (top right)
  const badgeText = data.status.toUpperCase();
  doc
    .font('Helvetica-Bold')
    .fontSize(8)
    .fillColor(data.status === 'Finalised' ? MINT : '#F59E0B')
    .opacity(1)
    .text(badgeText, 595 - 40 - 80, 27, { width: 80, align: 'right' });

  // ── Title row ─────────────────────────────────────────────────────────────────
  const monthYear = `${MONTH_NAMES[data.month] ?? ''} ${data.year}`;
  doc
    .font('Helvetica-Bold')
    .fontSize(14)
    .fillColor(CHARCOAL)
    .opacity(1)
    .text(`Payslip — ${monthYear}`, 40, 85);

  doc
    .font('Helvetica')
    .fontSize(8)
    .fillColor(SLATE)
    .text(`Code: ${data.code}  |  Run: ${data.runCode}  |  Period: ${data.periodStart} to ${data.periodEnd}`, 40, 103);

  // ── Employee details grid ─────────────────────────────────────────────────────
  const detailsY = 125;
  doc
    .rect(40, detailsY, PAGE_W, 1)
    .fillColor(SAGE)
    .fill();

  const details: Array<[string, string]> = [
    ['Employee', data.employeeName],
    ['Employee Code', data.employeeCode],
    ['Designation', data.designation ?? '—'],
    ['Department', data.department ?? '—'],
    ['Working Days', String(data.workingDays)],
    ['Days Worked', String(data.daysWorked)],
    ['LOP Days', String(data.lopDays)],
    ['Period', `${data.periodStart} to ${data.periodEnd}`],
  ];

  const CELL_W = PAGE_W / 2;
  details.forEach(([label, value], i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x = 40 + col * CELL_W;
    const y = detailsY + 10 + row * 22;

    doc.font('Helvetica').fontSize(8).fillColor(SLATE).text(label, x, y);
    doc
      .font('Helvetica-Bold')
      .fontSize(9)
      .fillColor(CHARCOAL)
      .text(value, x, y + 10);
  });

  // ── Earnings / Deductions tables ──────────────────────────────────────────────
  const tableY = detailsY + 10 + Math.ceil(details.length / 2) * 22 + 20;

  // Table header — Earnings
  doc.rect(40, tableY, PAGE_W, 20).fill(FOREST);
  doc
    .font('Helvetica-Bold')
    .fontSize(9)
    .fillColor('#FFFFFF')
    .text('EARNINGS', 48, tableY + 6);
  doc.text('AMOUNT', 40 + PAGE_W - 80, tableY + 6, { width: 72, align: 'right' });

  const earningsRows: Array<[string, number]> = [
    ['Basic Salary', data.basicPaise],
    ['Allowances', data.allowancesPaise],
  ];

  let rowY = tableY + 20;
  const ROW_H = 20;

  earningsRows.forEach(([label, paise], i) => {
    if (i % 2 === 0) {
      doc.rect(40, rowY, PAGE_W, ROW_H).fill(OFFWHITE);
    }
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor(CHARCOAL)
      .text(label, 48, rowY + 6);
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor(CHARCOAL)
      .text(formatPaise(paise), 40, rowY + 6, { width: PAGE_W - 8, align: 'right' });
    rowY += ROW_H;
  });

  // Gross row
  doc.rect(40, rowY, PAGE_W, ROW_H).fill('#E8F5ED');
  doc
    .font('Helvetica-Bold')
    .fontSize(9)
    .fillColor(FOREST)
    .text('Gross Pay (Pro-rated)', 48, rowY + 6);
  doc
    .font('Helvetica-Bold')
    .fontSize(9)
    .fillColor(FOREST)
    .text(formatPaise(data.grossPaise), 40, rowY + 6, { width: PAGE_W - 8, align: 'right' });
  rowY += ROW_H + 12;

  // Deductions table
  doc.rect(40, rowY, PAGE_W, 20).fill('#7F1D1D');
  doc
    .font('Helvetica-Bold')
    .fontSize(9)
    .fillColor('#FFFFFF')
    .text('DEDUCTIONS', 48, rowY + 6);
  doc.text('AMOUNT', 40 + PAGE_W - 80, rowY + 6, { width: 72, align: 'right' });
  rowY += 20;

  const deductionRows: Array<[string, number]> = [
    ['Loss of Pay', data.lopDeductionPaise],
    [`Income Tax (Ref: ${formatPaise(data.referenceTaxPaise)})`, data.finalTaxPaise],
    ['Other Deductions', data.otherDeductionsPaise],
  ];

  deductionRows.forEach(([label, paise], i) => {
    if (i % 2 === 0) {
      doc.rect(40, rowY, PAGE_W, ROW_H).fill(OFFWHITE);
    }
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor(CHARCOAL)
      .text(label, 48, rowY + 6);
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor(CHARCOAL)
      .text(formatPaise(paise), 40, rowY + 6, { width: PAGE_W - 8, align: 'right' });
    rowY += ROW_H;
  });

  rowY += 12;

  // ── Net Pay panel ─────────────────────────────────────────────────────────────
  doc.rect(40, rowY, PAGE_W, 48).fill(FOREST);
  doc
    .font('Helvetica')
    .fontSize(10)
    .fillColor('#FFFFFF')
    .opacity(0.8)
    .text('NET PAY', 48, rowY + 10);
  doc
    .font('Helvetica-Bold')
    .fontSize(20)
    .fillColor('#FFFFFF')
    .opacity(1)
    .text(formatPaise(data.netPayPaise), 40, rowY + 6, { width: PAGE_W - 8, align: 'right' });

  rowY += 60;

  // ── Reversal notice ───────────────────────────────────────────────────────────
  if (data.reversalOfPayslipId) {
    doc
      .rect(40, rowY, PAGE_W, 24)
      .strokeColor('#F59E0B')
      .lineWidth(1)
      .stroke();
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor('#92400E')
      .text(
        `This is a REVERSAL payslip. Original payslip ID: ${data.reversalOfPayslipId}`,
        48,
        rowY + 8,
      );
    rowY += 32;
  }

  // ── Footer ─────────────────────────────────────────────────────────────────────
  const footerY = 770;
  doc.rect(40, footerY, PAGE_W, 1).fillColor(SAGE).fill();
  doc
    .font('Helvetica')
    .fontSize(7)
    .fillColor(SLATE)
    .opacity(0.9)
    .text(
      'This is a computer-generated payslip and does not require a signature. ' +
        (data.finalisedAt
          ? `Finalised on ${new Date(data.finalisedAt).toLocaleDateString('en-IN')}.`
          : 'Status: ' + data.status + '.'),
      40,
      footerY + 6,
      { width: PAGE_W, align: 'center' },
    );

  doc.end();
}
