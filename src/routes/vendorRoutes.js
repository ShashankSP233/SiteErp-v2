const express = require('express');

const vendorRepo = require('../repositories/vendorRepo');
const { logAudit } = require('../repositories/auditRepo');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// ------------------------------------------------------------
// Vendor List
// ------------------------------------------------------------

router.get('/vendors', requireAuth, async (req, res, next) => {
    try {
        const includeInactive =
            req.query.showInactive === '1' &&
            ['admin', 'manager'].includes(req.session.user.role);

        const vendors = await vendorRepo.listVendors({
            includeInactive
        });

        res.render('vendors/list', {
            title: 'Vendors',
            vendors,
            showInactive: includeInactive
        });
    } catch (err) {
        next(err);
    }
});

// ------------------------------------------------------------
// Create Vendor
// ------------------------------------------------------------

router.get(
    '/vendors/new',
    requireAuth,
    requireRole('admin', 'manager'),
    (req, res) => {
        res.render('vendors/form', {
            title: 'Add Vendor',
            vendor: {},
            formAction: '/vendors',
            isEdit: false
        });
    }
);

router.post(
    '/vendors',
    requireAuth,
    requireRole('admin', 'manager'),
    async (req, res) => {
        try {
            const vendor = await vendorRepo.createVendor({
                vendorCode: req.body.vendorCode,
                name: req.body.name,
                contactPerson: req.body.contactPerson,
                email: req.body.email,
                phone: req.body.phone,
                address: req.body.address,
                taxIdentifier: req.body.taxIdentifier,
                notes: req.body.notes
            });

            await logAudit({
                userId: req.session.user.id,
                action: 'CREATE_VENDOR',
                entity: 'vendors',
                entityId: vendor.id,
                details: {
                    vendorCode: vendor.vendor_code,
                    name: vendor.name
                },
                ip: req.ip,
                userAgent: req.get('user-agent')
            });

            req.session.success = 'Vendor created successfully.';
            res.redirect('/vendors');
        } catch (err) {
            req.session.error = err.message;
            res.redirect('/vendors/new');
        }
    }
);

// ------------------------------------------------------------
// Edit Vendor
// ------------------------------------------------------------

router.get(
    '/vendors/:id/edit',
    requireAuth,
    requireRole('admin', 'manager'),
    async (req, res, next) => {
        try {
            const vendor = await vendorRepo.getVendorById(req.params.id);

            if (!vendor) {
                return res
                    .status(404)
                    .render('errors/404', {
                        title: 'Vendor not found'
                    });
            }

            res.render('vendors/form', {
                title: 'Edit Vendor',
                vendor,
                formAction: `/vendors/${vendor.id}`,
                isEdit: true
            });
        } catch (err) {
            next(err);
        }
    }
);

router.post(
    '/vendors/:id',
    requireAuth,
    requireRole('admin', 'manager'),
    async (req, res) => {
        try {
            const vendor = await vendorRepo.updateVendor(
                req.params.id,
                {
                    vendorCode: req.body.vendorCode,
                    name: req.body.name,
                    contactPerson: req.body.contactPerson,
                    email: req.body.email,
                    phone: req.body.phone,
                    address: req.body.address,
                    taxIdentifier: req.body.taxIdentifier,
                    notes: req.body.notes,
                    isActive: req.body.isActive === 'true'
                }
            );

            if (!vendor) {
                req.session.error = 'Vendor not found.';
                return res.redirect('/vendors');
            }

            await logAudit({
                userId: req.session.user.id,
                action: 'UPDATE_VENDOR',
                entity: 'vendors',
                entityId: vendor.id,
                details: {
                    vendorCode: vendor.vendor_code,
                    name: vendor.name,
                    isActive: vendor.is_active
                },
                ip: req.ip,
                userAgent: req.get('user-agent')
            });

            req.session.success = 'Vendor updated successfully.';
            res.redirect('/vendors');
        } catch (err) {
            req.session.error = err.message;
            res.redirect(`/vendors/${req.params.id}/edit`);
        }
    }
);

// ------------------------------------------------------------
// Activate / Deactivate Vendor
// ------------------------------------------------------------

router.post(
    '/vendors/:id/status',
    requireAuth,
    requireRole('admin', 'manager'),
    async (req, res) => {
        try {
            const isActive = req.body.isActive === 'true';

            const vendor = await vendorRepo.setVendorActive(
                req.params.id,
                isActive
            );

            if (!vendor) {
                req.session.error = 'Vendor not found.';
                return res.redirect('/vendors');
            }

            await logAudit({
                userId: req.session.user.id,
                action: isActive
                    ? 'ACTIVATE_VENDOR'
                    : 'DEACTIVATE_VENDOR',
                entity: 'vendors',
                entityId: vendor.id,
                details: {
                    vendorCode: vendor.vendor_code,
                    name: vendor.name
                },
                ip: req.ip,
                userAgent: req.get('user-agent')
            });

            req.session.success = isActive
                ? 'Vendor activated.'
                : 'Vendor deactivated.';

            res.redirect('/vendors');
        } catch (err) {
            req.session.error = err.message;
            res.redirect('/vendors');
        }
    }
);

module.exports = router;