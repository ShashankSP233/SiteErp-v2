const db = require('../config/db');

/**
 * List stock transfers visible to the current user.
 *
 * Admin:
 *   - Can see all transfers.
 *
 * Manager / Operator / Viewer:
 *   - Can only see transfers where their user account
 *     is actively assigned to either the source or destination site.
 *
 * Filters:
 *   transferNumber
 *   fromSiteId
 *   toSiteId
 *   status
 *   dateFrom
 *   dateTo
 */
async function listStockTransfersForUser(
    user,
    {
        transferNumber = '',
        fromSiteId = '',
        toSiteId = '',
        status = '',
        dateFrom = '',
        dateTo = ''
    } = {}
) {
    const conditions = [];
    const params = [];

    /*
     * ------------------------------------------------------------
     * SITE ACCESS
     * ------------------------------------------------------------
     *
     * Admins can see every transfer.
     *
     * Other users can only see a transfer if they are currently
     * assigned to either the source site or destination site.
     */
    if (user.role !== 'admin') {
        params.push(user.id);
        const userIdParam1 = `$${params.length}`;

        params.push(user.id);
        const userIdParam2 = `$${params.length}`;

        conditions.push(`
            (
                EXISTS (
                    SELECT 1
                    FROM site_assignments sa_from
                    WHERE sa_from.user_id = ${userIdParam1}
                      AND sa_from.site_id = st.from_site_id
                      AND sa_from.assigned_until IS NULL
                )
                OR
                EXISTS (
                    SELECT 1
                    FROM site_assignments sa_to
                    WHERE sa_to.user_id = ${userIdParam2}
                      AND sa_to.site_id = st.to_site_id
                      AND sa_to.assigned_until IS NULL
                )
            )
        `);
    }

    /*
     * ------------------------------------------------------------
     * TRANSFER NUMBER
     * ------------------------------------------------------------
     */
    if (String(transferNumber).trim()) {
        params.push(`%${String(transferNumber).trim()}%`);

        conditions.push(
            `st.transfer_number ILIKE $${params.length}`
        );
    }

    /*
     * ------------------------------------------------------------
     * SOURCE SITE
     * ------------------------------------------------------------
     */
    if (fromSiteId) {
        params.push(fromSiteId);

        conditions.push(
            `st.from_site_id = $${params.length}`
        );
    }

    /*
     * ------------------------------------------------------------
     * DESTINATION SITE
     * ------------------------------------------------------------
     */
    if (toSiteId) {
        params.push(toSiteId);

        conditions.push(
            `st.to_site_id = $${params.length}`
        );
    }

    /*
     * ------------------------------------------------------------
     * STATUS
     * ------------------------------------------------------------
     */
    if (status) {
        params.push(status);

        conditions.push(
            `st.status = $${params.length}`
        );
    }

    /*
     * ------------------------------------------------------------
     * DATE FROM
     * ------------------------------------------------------------
     */
    if (dateFrom) {
        params.push(dateFrom);

        conditions.push(
            `st.created_at >= $${params.length}::date`
        );
    }

    /*
     * ------------------------------------------------------------
     * DATE TO
     *
     * Use the next day so the entire selected date is included.
     * ------------------------------------------------------------
     */
    if (dateTo) {
        params.push(dateTo);

        conditions.push(`
            st.created_at <
            ($${params.length}::date + INTERVAL '1 day')
        `);
    }

    const whereClause = conditions.length
        ? `WHERE ${conditions.join('\nAND ')}`
        : '';

    /*
     * ------------------------------------------------------------
     * QUERY
     * ------------------------------------------------------------
     */
    const result = await db.query(
        `
        SELECT
            st.id,
            st.transfer_number,

            st.from_site_id,
            fs.code AS from_site_code,
            fs.name AS from_site_name,

            st.to_site_id,
            ts.code AS to_site_code,
            ts.name AS to_site_name,

            st.status,
            st.notes,

            st.created_by,
            st.created_at,

            st.dispatched_by,
            st.dispatched_at,

            st.completed_at,
            st.updated_at,

            COUNT(sti.id) AS item_count,

            COUNT(
                CASE
                    WHEN sti.status = 'RECEIVED'
                    THEN 1
                END
            ) AS received_count,

            COUNT(
                CASE
                    WHEN sti.status = 'IN_TRANSIT'
                    THEN 1
                END
            ) AS in_transit_count,

            COUNT(
                CASE
                    WHEN sti.status = 'MIA'
                    THEN 1
                END
            ) AS mia_count

        FROM stock_transfers st

        INNER JOIN sites fs
            ON fs.id = st.from_site_id

        INNER JOIN sites ts
            ON ts.id = st.to_site_id

        LEFT JOIN stock_transfer_items sti
            ON sti.transfer_id = st.id

        ${whereClause}

        GROUP BY
            st.id,
            st.transfer_number,

            st.from_site_id,
            fs.code,
            fs.name,

            st.to_site_id,
            ts.code,
            ts.name,

            st.status,
            st.notes,

            st.created_by,
            st.created_at,

            st.dispatched_by,
            st.dispatched_at,

            st.completed_at,
            st.updated_at

        ORDER BY
            st.created_at DESC,
            st.id DESC
        `,
        params
    );

    return result.rows;
}

module.exports = {
    listStockTransfersForUser
};