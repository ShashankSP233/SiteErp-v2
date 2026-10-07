const fs = require('fs');
const path = require('path');
const express = require('express');

const env = require('../config/env');
const vendorRepo = require('../repositories/vendorRepo');
const { logAudit } = require('../repositories/auditRepo');
const { requireAuth, requireRole } = require('../middleware/auth');
const { upload, uploadDir } = require('../middleware/upload');
const { validateVendor } = require('../utils/vendorValidation');

const router = express.Router();
const managerOnly = [requireAuth, requireRole('admin', 'manager')];

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

// multipart bodies are not parsed when the global CSRF check runs, so the forms
// send the token in the query string (csrf.js already accepts req.query._csrf).
const DOC_FIELDS = [
    { name: 'gstCertificate', maxCount: 1 },
    { name: 'panCertificate', maxCount: 1 },
    { name: 'cancelledCheque', maxCount: 1 }
];
const docUpload = upload.fields(DOC_FIELDS);

function uploadVendorDocs(req, res, next) {
    docUpload(req, res, (err) => {
        if (!err) return next();
        // multer removes any partially uploaded files itself
        req.session.error = err.code === 'LIMIT_FILE_SIZE'
            ? `File is too large (maximum ${env.maxUploadMb} MB per file).`
            : err.message;
        res.redirect(req.params.id ? `/vendors/${req.params.id}/edit` : '/vendors/new');
    });
}

function pickFiles(req) {
    const f = req.files || {};
    return {
        gstCertificate: f.gstCertificate?.[0],
        panCertificate: f.panCertificate?.[0],
        cancelledCheque: f.cancelledCheque?.[0]
    };
}

function deleteStoredFiles(names) {
    names.filter(Boolean).forEach((name) => {
        fs.promises.unlink(path.join(uploadDir, path.basename(name))).catch(() => {});
    });
}

function uploadedNames(files) {
    return Object.values(files).filter(Boolean).map((f) => f.filename);
}

// Values to refill the form with after a validation error.
function formModel(body, existing) {
    return {
        ...(existing || {}),
        vendor_code: existing?.vendor_code,
        name: body.name,
        contact_person: body.contactPerson,
        email: body.email,
        phone: body.phone,
        address: body.address,
        notes: body.notes,
        tax_type: body.taxType === 'PAN' ? 'PAN' : 'GST',
        gst_no: body.gstNo,
        pan_no: body.panNo,
        udyam_id: body.udyamId,
        bank_account_no: body.bankAccountNo,
        bank_name: body.bankName,
        ifsc_code: body.ifscCode,
        is_active: body.isActive === undefined ? existing?.is_active : body.isActive === 'true'
    };
}

async function renderForm(res, { status = 200, vendor, isEdit, formErrors = [], nextVendorCode = null }) {
    res.status(status).render('vendors/form', {
        title: isEdit ? 'Edit Vendor' : 'Add Vendor',
        vendor,
        isEdit,
        formAction: isEdit ? `/vendors/${vendor.id}` : '/vendors',
        formErrors,
        nextVendorCode
    });
}

// ------------------------------------------------------------
// Vendor List
// ------------------------------------------------------------

router.get('/vendors', requireAuth, async (req, res, next) => {
    try {
        const includeInactive =
            req.query.showInactive === '1' &&
            ['admin', 'manager'].includes(req.session.user.role);

        const vendors = await vendorRepo.listVendors({ includeInactive });

        res.render('vendors/list', { title: 'Vendors', vendors, showInactive: includeInactive });
    } catch (err) {
        next(err);
    }
});

// ------------------------------------------------------------
// Create Vendor
// ------------------------------------------------------------

router.get('/vendors/new', ...managerOnly, async (req, res, next) => {
    try {
        await renderForm(res, {
            vendor: {},
            isEdit: false,
            nextVendorCode: await vendorRepo.nextVendorCode()
        });
    } catch (err) {
        next(err);
    }
});

router.post('/vendors', ...managerOnly, uploadVendorDocs, async (req, res, next) => {
    const files = pickFiles(req);
    try {
        const { values, errors } = validateVendor(req.body, { existing: null, files });

        if (!errors.length) {
            const dup = await vendorRepo.findDuplicateTaxNumber({ gstNo: values.gstNo, panNo: values.panNo });
            if (dup) errors.push(`This GST/PAN number already belongs to vendor ${dup.vendor_code} (${dup.name}).`);
        }

        if (errors.length) {
            deleteStoredFiles(uploadedNames(files));
            return renderForm(res, {
                status: 400,
                vendor: formModel(req.body, null),
                isEdit: false,
                formErrors: errors,
                nextVendorCode: await vendorRepo.nextVendorCode()
            });
        }

        const vendor = await vendorRepo.createVendor(values);

        await logAudit({
            userId: req.session.user.id,
            action: 'CREATE_VENDOR',
            entity: 'vendors',
            entityId: vendor.id,
            details: { vendorCode: vendor.vendor_code, name: vendor.name },
            ip: req.ip,
            userAgent: req.get('user-agent')
        });

        req.session.success = `Vendor created successfully (${vendor.vendor_code}).`;
        res.redirect('/vendors');
    } catch (err) {
        deleteStoredFiles(uploadedNames(files));
        next(err);
    }
});

// ------------------------------------------------------------
// Vendor detail + document download (admin / manager only)
// ------------------------------------------------------------

router.get('/vendors/:id/documents/:kind', ...managerOnly, async (req, res, next) => {
    try {
        const column = {
            gst: 'gst_certificate_file',
            pan: 'pan_certificate_file',
            cheque: 'cancelled_cheque_file'
        }[req.params.kind];
        const vendor = column ? await vendorRepo.getVendorById(req.params.id) : null;
        const stored = vendor && vendor[column];
        const full = stored ? path.join(uploadDir, path.basename(stored)) : null;

        if (!full || !fs.existsSync(full)) {
            return res.status(404).render('errors/404', { title: 'File not found' });
        }
        res.sendFile(full); // inline: opens PDFs / images in the browser
    } catch (err) {
        next(err);
    }
});

router.get('/vendors/:id(\\d+)', ...managerOnly, async (req, res, next) => {
    try {
        const vendor = await vendorRepo.getVendorById(req.params.id);
        if (!vendor) {
            return res.status(404).render('errors/404', { title: 'Vendor not found' });
        }
        res.render('vendors/detail', { title: vendor.name, vendor });
    } catch (err) {
        next(err);
    }
});

// ------------------------------------------------------------
// Edit Vendor
// ------------------------------------------------------------

router.get('/vendors/:id/edit', ...managerOnly, async (req, res, next) => {
    try {
        const vendor = await vendorRepo.getVendorById(req.params.id);
        if (!vendor) {
            return res.status(404).render('errors/404', { title: 'Vendor not found' });
        }
        await renderForm(res, { vendor, isEdit: true });
    } catch (err) {
        next(err);
    }
});

router.post('/vendors/:id', ...managerOnly, uploadVendorDocs, async (req, res, next) => {
    const files = pickFiles(req);
    try {
        const existing = await vendorRepo.getVendorById(req.params.id);
        if (!existing) {
            deleteStoredFiles(uploadedNames(files));
            req.session.error = 'Vendor not found.';
            return res.redirect('/vendors');
        }

        const { values, errors, obsoleteFiles } = validateVendor(req.body, { existing, files });

        if (!errors.length) {
            const dup = await vendorRepo.findDuplicateTaxNumber({
                gstNo: values.gstNo, panNo: values.panNo, excludeId: existing.id
            });
            if (dup) errors.push(`This GST/PAN number already belongs to vendor ${dup.vendor_code} (${dup.name}).`);
        }

        if (errors.length) {
            deleteStoredFiles(uploadedNames(files));
            return renderForm(res, {
                status: 400,
                vendor: formModel(req.body, existing),
                isEdit: true,
                formErrors: errors
            });
        }

        const vendor = await vendorRepo.updateVendor(existing.id, values, req.body.isActive === 'true');
        deleteStoredFiles(obsoleteFiles); // old files that were replaced or cleared

        await logAudit({
            userId: req.session.user.id,
            action: 'UPDATE_VENDOR',
            entity: 'vendors',
            entityId: vendor.id,
            details: { vendorCode: vendor.vendor_code, name: vendor.name, isActive: vendor.is_active },
            ip: req.ip,
            userAgent: req.get('user-agent')
        });

        req.session.success = 'Vendor updated successfully.';
        res.redirect('/vendors');
    } catch (err) {
        deleteStoredFiles(uploadedNames(files));
        next(err);
    }
});

// ------------------------------------------------------------
// Activate / Deactivate Vendor
// ------------------------------------------------------------

router.post('/vendors/:id/status', ...managerOnly, async (req, res) => {
    try {
        const isActive = req.body.isActive === 'true';
        const vendor = await vendorRepo.setVendorActive(req.params.id, isActive);

        if (!vendor) {
            req.session.error = 'Vendor not found.';
            return res.redirect('/vendors');
        }

        await logAudit({
            userId: req.session.user.id,
            action: isActive ? 'ACTIVATE_VENDOR' : 'DEACTIVATE_VENDOR',
            entity: 'vendors',
            entityId: vendor.id,
            details: { vendorCode: vendor.vendor_code, name: vendor.name },
            ip: req.ip,
            userAgent: req.get('user-agent')
        });

        req.session.success = isActive ? 'Vendor activated.' : 'Vendor deactivated.';
        res.redirect('/vendors');
    } catch (err) {
        req.session.error = err.message;
        res.redirect('/vendors');
    }
});

module.exports = router;