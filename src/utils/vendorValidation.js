const GST_RE    = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const PAN_RE    = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const IFSC_RE   = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const UDYAM_RE  = /^UDYAM-[A-Z]{2}-[0-9]{2}-[0-9]{7}$/;
const ACCOUNT_RE = /^[0-9]{9,18}$/;

const text  = v => String(v ?? '').trim();
const upper = v => text(v).toUpperCase().replace(/\s+/g, '');

function validateVendor(body, { existing = null, files = {} } = {}) {
  const errors = [];
  const taxType = body.taxType === 'PAN' ? 'PAN' : 'GST';

  const values = {
    name: text(body.name),
    contactPerson: text(body.contactPerson) || null,
    email: text(body.email) || null,
    phone: text(body.phone) || null,
    address: text(body.address) || null,
    notes: text(body.notes) || null,
    taxType,
    gstNo: null, gstCertificateFile: null,
    panNo: null, panCertificateFile: null,
    udyamId: upper(body.udyamId) || null,
    bankAccountNo: text(body.bankAccountNo).replace(/[\s-]/g, ''),
    bankName: text(body.bankName),
    ifscCode: upper(body.ifscCode),
    cancelledChequeFile: null
  };

  if (!values.name) errors.push('Vendor name is required.');

  if (taxType === 'GST') {
    values.gstNo = upper(body.gstNo);
    if (!values.gstNo) errors.push('GST number is required (or choose PAN if the vendor is not GST registered).');
    else if (!GST_RE.test(values.gstNo)) errors.push('GST number is not a valid 15-character GSTIN.');
    values.gstCertificateFile = files.gstCertificate?.filename || existing?.gst_certificate_file || null;
    if (!values.gstCertificateFile) errors.push('GST certificate is required.');
  } else {
    values.panNo = upper(body.panNo);
    if (!values.panNo) errors.push('PAN number is required.');
    else if (!PAN_RE.test(values.panNo)) errors.push('PAN number is not valid (format ABCDE1234F).');
    values.panCertificateFile = files.panCertificate?.filename || existing?.pan_certificate_file || null;
    if (!values.panCertificateFile) errors.push('PAN certificate is required.');
  }

  if (values.udyamId && !UDYAM_RE.test(values.udyamId)) {
    errors.push('Udyam ID is not valid (format UDYAM-XX-00-0000000).');
  }

  if (!values.bankAccountNo) errors.push('Bank account number is required.');
  else if (!ACCOUNT_RE.test(values.bankAccountNo)) errors.push('Bank account number must be 9 to 18 digits.');
  if (!values.bankName) errors.push('Bank name is required.');
  if (!values.ifscCode) errors.push('IFSC code is required.');
  else if (!IFSC_RE.test(values.ifscCode)) errors.push('IFSC code is not valid (format ABCD0123456).');
  values.cancelledChequeFile = files.cancelledCheque?.filename || existing?.cancelled_cheque_file || null;
  if (!values.cancelledChequeFile) errors.push('Photo of the cancelled cheque is required.');

  // previously stored files that are being replaced/cleared
  const obsoleteFiles = [];
  if (existing) {
    [
      [existing.gst_certificate_file, values.gstCertificateFile],
      [existing.pan_certificate_file, values.panCertificateFile],
      [existing.cancelled_cheque_file, values.cancelledChequeFile]
    ].forEach(([oldFile, newFile]) => {
      if (oldFile && oldFile !== newFile) obsoleteFiles.push(oldFile);
    });
  }

  return { values, errors, obsoleteFiles };
}

module.exports = { validateVendor, GST_RE, PAN_RE, IFSC_RE, UDYAM_RE, ACCOUNT_RE };