const express = require('express');

const siteRepo = require('../repositories/siteRepo');
const { logAudit } = require('../repositories/auditRepo');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();


// ============================================================
// SITE LIST
// ============================================================

router.get(
  '/sites',
  requireAuth,
  requireRole('admin'),
  async (req, res, next) => {
    try {
      const sites = await siteRepo.listSites();

      res.render('sites/list', {
        title: 'Sites',
        sites
      });
    } catch (err) {
      next(err);
    }
  }
);


// ============================================================
// CREATE SITE FORM
// ============================================================

router.get(
  '/sites/new',
  requireAuth,
  requireRole('admin'),
  (req, res) => {
    res.render('sites/form', {
      title: 'Create Site',
      site: {}
    });
  }
);


// ============================================================
// CREATE SITE
// ============================================================

router.post(
  '/sites',
  requireAuth,
  requireRole('admin'),
  async (req, res) => {
    try {
      const {
        code,
        name,
        siteType,
        address
      } = req.body;

      if (!code?.trim()) {
        throw new Error('Site code is required.');
      }

      if (!name?.trim()) {
        throw new Error('Site name is required.');
      }

      if (!['NORMAL', 'SUPER_STORE'].includes(siteType)) {
        throw new Error('Invalid site type.');
      }

      const site = await siteRepo.createSite({
        code,
        name,
        siteType,
        address
      });

      await logAudit({
        userId: req.session.user.id,
        action: 'CREATE_SITE',
        entity: 'sites',
        entityId: site.id,
        details: {
          code: site.code,
          name: site.name,
          siteType: site.site_type
        },
        ip: req.ip,
        userAgent: req.get('user-agent')
      });

      req.session.success = 'Site created successfully.';

      res.redirect('/sites');

    } catch (err) {
      req.session.error = err.message;

      res.redirect('/sites/new');
    }
  }
);


// ============================================================
// EDIT SITE FORM
// ============================================================

router.get(
  '/sites/:id/edit',
  requireAuth,
  requireRole('admin'),
  async (req, res, next) => {
    try {
      const site = await siteRepo.getSiteById(req.params.id);

      if (!site) {
        return res.status(404).render('errors/404', {
          title: 'Site not found'
        });
      }

      res.render('sites/form', {
        title: 'Edit Site',
        site
      });

    } catch (err) {
      next(err);
    }
  }
);


// ============================================================
// UPDATE SITE
// ============================================================

router.post(
  '/sites/:id',
  requireAuth,
  requireRole('admin'),
  async (req, res) => {
    try {
      const {
        name,
        siteType,
        address,
        status
      } = req.body;

      if (!name?.trim()) {
        throw new Error('Site name is required.');
      }

      if (!['NORMAL', 'SUPER_STORE'].includes(siteType)) {
        throw new Error('Invalid site type.');
      }

      if (!['ACTIVE', 'INACTIVE'].includes(status)) {
        throw new Error('Invalid site status.');
      }

      const site = await siteRepo.updateSite(
        req.params.id,
        {
          name,
          siteType,
          address,
          status
        }
      );

      await logAudit({
        userId: req.session.user.id,
        action: 'UPDATE_SITE',
        entity: 'sites',
        entityId: req.params.id,
        details: {
          name: site.name,
          siteType: site.site_type,
          status: site.status
        },
        ip: req.ip,
        userAgent: req.get('user-agent')
      });

      req.session.success = 'Site updated successfully.';

      res.redirect('/sites');

    } catch (err) {
      req.session.error = err.message;

      res.redirect(`/sites/${req.params.id}/edit`);
    }
  }
);


module.exports = router;