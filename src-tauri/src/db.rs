#![allow(dead_code)]
//! Local-first cache (SQLite via rusqlite, bundled). The UI reads ONLY from
//! here — instant, offline, zero rate-limit risk. The sync engine pulls WB into
//! these tables; write commands update them after a successful WB write.
//!
//! All functions are synchronous and take `&Connection`. Callers must do their
//! WB network I/O FIRST (async), then lock the connection and write (sync) —
//! never hold the std Mutex guard across an await.

use crate::wb::marketplace::Warehouse;
use anyhow::Result;
use rusqlite::{params, Connection};
use serde::Serialize;

const SCHEMA: &str = r#"
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS products (
  nm_id           INTEGER PRIMARY KEY,
  vendor_code     TEXT NOT NULL DEFAULT '',
  title           TEXT NOT NULL DEFAULT '',
  brand           TEXT NOT NULL DEFAULT '',
  subject_id      INTEGER NOT NULL DEFAULT 0,
  subject_name    TEXT NOT NULL DEFAULT '',
  photo           TEXT,
  characteristics INTEGER NOT NULL DEFAULT 0,
  skus            TEXT NOT NULL DEFAULT '[]',
  rejected        INTEGER NOT NULL DEFAULT 0,
  synced_at       INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS prices (
  nm_id            INTEGER PRIMARY KEY,
  price            INTEGER NOT NULL DEFAULT 0,
  discounted_price INTEGER NOT NULL DEFAULT 0,
  discount         INTEGER NOT NULL DEFAULT 0,
  currency         TEXT NOT NULL DEFAULT 'RUB',
  synced_at        INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS stocks (
  warehouse_id INTEGER NOT NULL,
  sku          TEXT NOT NULL,
  amount       INTEGER NOT NULL DEFAULT 0,
  synced_at    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (warehouse_id, sku)
);
CREATE TABLE IF NOT EXISTS warehouses (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL DEFAULT '',
  office_id     INTEGER NOT NULL DEFAULT 0,
  cargo_type    INTEGER NOT NULL DEFAULT 0,
  delivery_type INTEGER NOT NULL DEFAULT 0,
  synced_at     INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sync_meta (
  key            TEXT PRIMARY KEY,
  last_sync_at   INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT '',
  detail         TEXT NOT NULL DEFAULT '',
  cooldown_until INTEGER NOT NULL DEFAULT 0
);
"#;

/// Bump on any schema change. The cache is DISPOSABLE: on an upgrade we drop +
/// recreate (then the user re-syncs) rather than write column-add migrations —
/// avoids a future "no such column" against get_managed_cards' fixed SELECT.
const SCHEMA_VERSION: i64 = 1;

pub fn open(path: &std::path::Path) -> Result<Connection> {
    let conn = Connection::open(path)?;
    conn.execute_batch(SCHEMA)?;
    migrate(&conn)?;
    Ok(conn)
}

/// In-memory DB for tests.
pub fn open_memory() -> Result<Connection> {
    let conn = Connection::open_in_memory()?;
    conn.execute_batch(SCHEMA)?;
    migrate(&conn)?;
    Ok(conn)
}

fn migrate(conn: &Connection) -> Result<()> {
    let v: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap_or(0);
    if v < SCHEMA_VERSION {
        // v==0 = fresh DB or a pre-versioning DB that already matches v1's schema
        // (so don't wipe it); a real version bump (v>=1 < current) drops+recreates.
        if v != 0 {
            conn.execute_batch(
                "DROP TABLE IF EXISTS products; DROP TABLE IF EXISTS prices;
                 DROP TABLE IF EXISTS stocks; DROP TABLE IF EXISTS warehouses;
                 DROP TABLE IF EXISTS sync_meta; DROP TABLE IF EXISTS kv;",
            )?;
            conn.execute_batch(SCHEMA)?;
        }
        conn.execute_batch(&format!("PRAGMA user_version = {};", SCHEMA_VERSION))?;
    }
    Ok(())
}

/// The cache belongs to ONE account+environment. If the active token/sandbox
/// changes, wipe the cached data so we never show sandbox rows on production
/// (or another seller's data). `key` = e.g. "sandbox:oid" or "live:oid".
pub fn ensure_account(conn: &Connection, key: &str) -> Result<()> {
    // An unauthenticated/unidentifiable account (empty token, or a keychain read
    // error) must NEVER overwrite or wipe a known account's cache.
    if key.ends_with(":none") {
        return Ok(());
    }
    let prev: Option<String> = conn
        .query_row("SELECT value FROM kv WHERE key='account'", [], |r| r.get(0))
        .ok();
    if prev.as_deref() != Some(key) {
        conn.execute_batch(
            "DELETE FROM products; DELETE FROM prices; DELETE FROM stocks; DELETE FROM warehouses; DELETE FROM sync_meta;",
        )?;
        conn.execute(
            "INSERT INTO kv(key,value) VALUES('account',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![key],
        )?;
    }
    Ok(())
}

/// Whether warehouse `id` is valid for the current account. Returns true when no
/// warehouses are synced yet (can't validate → don't block auto-stock); once a
/// set exists, only a member id passes. Guards pushing stock to a stale/foreign
/// warehouse after an environment or seller switch.
pub fn warehouse_allows(conn: &Connection, id: i64) -> Result<bool> {
    let total: i64 = conn.query_row("SELECT COUNT(*) FROM warehouses", [], |r| r.get(0))?;
    if total == 0 {
        return Ok(true);
    }
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM warehouses WHERE id=?1",
        params![id],
        |r| r.get(0),
    )?;
    Ok(n > 0)
}

// ── row types ────────────────────────────────────────────────────────────────

pub struct ProductRow {
    pub nm_id: i64,
    pub vendor_code: String,
    pub title: String,
    pub brand: String,
    pub subject_id: i64,
    pub subject_name: String,
    pub photo: Option<String>,
    pub characteristics: i64,
    pub skus: Vec<String>,
}

pub struct PriceRow {
    pub nm_id: i64,
    pub price: i64,
    pub discounted_price: i64,
    pub discount: i64,
    pub currency: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedCard {
    #[serde(rename = "nmID")]
    pub nm_id: i64,
    pub vendor_code: String,
    pub subject_name: String,
    pub brand: String,
    pub title: String,
    pub photo: Option<String>,
    pub skus: Vec<String>,
    pub price: Option<i64>,
    pub discounted_price: Option<i64>,
    pub discount: Option<i64>,
    pub currency: Option<String>,
    pub stock: Option<i64>,
    pub characteristics: i64,
    pub status: String,
    pub status_note: String,
}

// ── writes (upserts from the sync engine) ────────────────────────────────────

/// Upsert products. `full_snapshot` = `rows` is the COMPLETE card set (pagination
/// exhausted) — only then do we delete locally-cached cards absent from `rows`
/// (i.e. trashed elsewhere). If the sync was truncated at the page cap, we must
/// NOT delete, or cards beyond the cap would be wiped on every sync.
pub fn upsert_products(conn: &mut Connection, rows: &[ProductRow], now: i64, full_snapshot: bool) -> Result<usize> {
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare(
            "INSERT INTO products(nm_id,vendor_code,title,brand,subject_id,subject_name,photo,characteristics,skus,synced_at)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
             ON CONFLICT(nm_id) DO UPDATE SET
               vendor_code=excluded.vendor_code, title=excluded.title, brand=excluded.brand,
               subject_id=excluded.subject_id, subject_name=excluded.subject_name, photo=excluded.photo,
               characteristics=excluded.characteristics, skus=excluded.skus, synced_at=excluded.synced_at",
        )?;
        for p in rows {
            let skus = serde_json::to_string(&p.skus).unwrap_or_else(|_| "[]".into());
            stmt.execute(params![
                p.nm_id, p.vendor_code, p.title, p.brand, p.subject_id, p.subject_name,
                p.photo, p.characteristics, skus, now
            ])?;
        }
    }
    // Drop products that no longer exist on WB — ONLY on a complete snapshot
    // (truncated syncs must not prune). Also prune orphaned price rows in the
    // same transaction. Handles an emptied store (rows empty → clear all).
    if full_snapshot {
        if rows.is_empty() {
            tx.execute("DELETE FROM products", [])?;
            tx.execute("DELETE FROM prices", [])?;
        } else {
            // nm_ids are integers (safe to inline); NOT IN keeps the synced set.
            let in_list = rows.iter().map(|p| p.nm_id.to_string()).collect::<Vec<_>>().join(",");
            tx.execute(&format!("DELETE FROM products WHERE nm_id NOT IN ({})", in_list), [])?;
            tx.execute(&format!("DELETE FROM prices WHERE nm_id NOT IN ({})", in_list), [])?;
        }
    }
    tx.commit()?;
    Ok(rows.len())
}

/// Mark products rejected by vendorCode (from cards/error/list); clear others.
pub fn apply_rejections(conn: &Connection, rejected_vendor_codes: &[String]) -> Result<()> {
    conn.execute("UPDATE products SET rejected=0", [])?;
    let mut stmt = conn.prepare("UPDATE products SET rejected=1 WHERE vendor_code=?1")?;
    for vc in rejected_vendor_codes {
        stmt.execute(params![vc])?;
    }
    Ok(())
}

pub fn upsert_prices(conn: &mut Connection, rows: &[PriceRow], now: i64) -> Result<usize> {
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare(
            "INSERT INTO prices(nm_id,price,discounted_price,discount,currency,synced_at)
             VALUES(?1,?2,?3,?4,?5,?6)
             ON CONFLICT(nm_id) DO UPDATE SET
               price=excluded.price, discounted_price=excluded.discounted_price,
               discount=excluded.discount, currency=excluded.currency, synced_at=excluded.synced_at",
        )?;
        for p in rows {
            stmt.execute(params![p.nm_id, p.price, p.discounted_price, p.discount, p.currency, now])?;
        }
    }
    tx.commit()?;
    Ok(rows.len())
}

/// Replace the stock snapshot for one warehouse.
pub fn upsert_stocks(conn: &mut Connection, warehouse_id: i64, rows: &[(String, i64)], now: i64) -> Result<usize> {
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM stocks WHERE warehouse_id=?1", params![warehouse_id])?;
    {
        let mut stmt = tx.prepare(
            "INSERT INTO stocks(warehouse_id,sku,amount,synced_at) VALUES(?1,?2,?3,?4)
             ON CONFLICT(warehouse_id,sku) DO UPDATE SET amount=excluded.amount, synced_at=excluded.synced_at",
        )?;
        for (sku, amount) in rows {
            stmt.execute(params![warehouse_id, sku, amount, now])?;
        }
    }
    tx.commit()?;
    Ok(rows.len())
}

pub fn upsert_warehouses(conn: &mut Connection, whs: &[Warehouse], now: i64) -> Result<usize> {
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare(
            "INSERT INTO warehouses(id,name,office_id,cargo_type,delivery_type,synced_at)
             VALUES(?1,?2,?3,?4,?5,?6)
             ON CONFLICT(id) DO UPDATE SET name=excluded.name, office_id=excluded.office_id,
               cargo_type=excluded.cargo_type, delivery_type=excluded.delivery_type, synced_at=excluded.synced_at",
        )?;
        for w in whs {
            stmt.execute(params![w.id, w.name, w.office_id, w.cargo_type, w.delivery_type, now])?;
        }
    }
    tx.commit()?;
    Ok(whs.len())
}

pub fn get_warehouses(conn: &Connection) -> Result<Vec<Warehouse>> {
    let mut stmt = conn.prepare("SELECT id,name,office_id,cargo_type,delivery_type FROM warehouses ORDER BY name")?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Warehouse {
                id: r.get(0)?,
                name: r.get(1)?,
                office_id: r.get(2)?,
                cargo_type: r.get(3)?,
                delivery_type: r.get(4)?,
            })
        })?
        .filter_map(|x| x.ok())
        .collect();
    Ok(rows)
}

// ── post-write local updates (keep cache fresh after a WB write succeeds) ─────

pub fn local_set_stock(conn: &Connection, warehouse_id: i64, skus: &[String], amount: i64, now: i64) -> Result<()> {
    let mut stmt = conn.prepare(
        "INSERT INTO stocks(warehouse_id,sku,amount,synced_at) VALUES(?1,?2,?3,?4)
         ON CONFLICT(warehouse_id,sku) DO UPDATE SET amount=excluded.amount, synced_at=excluded.synced_at",
    )?;
    // Mirror the WB write: set_card_stock sets EVERY sku to `amount`, so the
    // optimistic cache must do the same (else a multi-size card diverges).
    for sku in skus {
        stmt.execute(params![warehouse_id, sku, amount, now])?;
    }
    Ok(())
}

pub fn local_set_price(conn: &Connection, nm_id: i64, price: i64, discount: i64, now: i64) -> Result<()> {
    let disc = discount.clamp(0, 99);
    let dp = ((price as f64) * (1.0 - disc as f64 / 100.0)).round() as i64;
    conn.execute(
        "INSERT INTO prices(nm_id,price,discounted_price,discount,currency,synced_at)
         VALUES(?1,?2,?3,?4,COALESCE((SELECT currency FROM prices WHERE nm_id=?1),'RUB'),?5)
         ON CONFLICT(nm_id) DO UPDATE SET price=excluded.price, discounted_price=excluded.discounted_price,
           discount=excluded.discount, synced_at=excluded.synced_at",
        params![nm_id, price, dp, disc, now],
    )?;
    Ok(())
}

pub fn local_delete(conn: &Connection, nm_ids: &[i64]) -> Result<()> {
    for nm in nm_ids {
        conn.execute("DELETE FROM products WHERE nm_id=?1", params![nm])?;
        conn.execute("DELETE FROM prices WHERE nm_id=?1", params![nm])?;
    }
    Ok(())
}

// ── read for the UI (instant, no network) ────────────────────────────────────

pub fn get_managed_cards(
    conn: &Connection,
    warehouse_id: Option<i64>,
    prices_synced: bool,
) -> Result<Vec<ManagedCard>> {
    use std::collections::HashMap;
    // prices
    let mut prices: HashMap<i64, PriceRow> = HashMap::new();
    {
        let mut stmt = conn.prepare("SELECT nm_id,price,discounted_price,discount,currency FROM prices")?;
        let it = stmt.query_map([], |r| {
            Ok(PriceRow {
                nm_id: r.get(0)?,
                price: r.get(1)?,
                discounted_price: r.get(2)?,
                discount: r.get(3)?,
                currency: r.get(4)?,
            })
        })?;
        for row in it.flatten() {
            prices.insert(row.nm_id, row);
        }
    }
    // Stock summed across ALL warehouses — a card's stock can be split between
    // warehouses, so the panel must show the true total sellable quantity. Reading
    // only the picked warehouse silently hid stock sitting on the others.
    let _ = warehouse_id; // warehouse selection now only targets 设库存, not display
    let stocks_synced: bool = conn
        .query_row("SELECT COUNT(*) FROM stocks", [], |r| r.get::<_, i64>(0))
        .unwrap_or(0)
        > 0;
    let mut stock_by_sku: HashMap<String, i64> = HashMap::new();
    {
        let mut stmt = conn.prepare("SELECT sku, SUM(amount) FROM stocks GROUP BY sku")?;
        let it = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
        for row in it.flatten() {
            stock_by_sku.insert(row.0, row.1);
        }
    }
    // products
    let mut stmt = conn.prepare(
        "SELECT nm_id,vendor_code,title,brand,subject_name,photo,characteristics,skus,rejected
         FROM products ORDER BY nm_id DESC",
    )?;
    let rows = stmt.query_map([], |r| {
        let skus_json: String = r.get(7)?;
        Ok((
            r.get::<_, i64>(0)?,    // nm_id
            r.get::<_, String>(1)?, // vendor_code
            r.get::<_, String>(2)?, // title
            r.get::<_, String>(3)?, // brand
            r.get::<_, String>(4)?, // subject_name
            r.get::<_, Option<String>>(5)?, // photo
            r.get::<_, i64>(6)?,    // characteristics
            skus_json,
            r.get::<_, i64>(8)? != 0, // rejected
        ))
    })?;

    // "stocks have been synced" — once true, stock 0 means truly out of stock
    // (across all warehouses), not "no warehouse picked".
    let warehouse_selected = stocks_synced;
    let mut out = vec![];
    for row in rows.flatten() {
        let (nm_id, vendor_code, title, brand, subject_name, photo, characteristics, skus_json, rejected) = row;
        let skus: Vec<String> = serde_json::from_str(&skus_json).unwrap_or_default();
        let pr = prices.get(&nm_id);
        let stock = if stocks_synced {
            Some(skus.iter().map(|s| stock_by_sku.get(s).copied().unwrap_or(0)).sum::<i64>())
        } else {
            None
        };
        let (status, note) = derive_status(rejected, pr.is_some(), prices_synced, warehouse_selected, stock);
        out.push(ManagedCard {
            nm_id,
            vendor_code,
            subject_name,
            brand,
            title,
            photo,
            skus,
            price: pr.map(|p| p.price),
            discounted_price: pr.map(|p| p.discounted_price),
            discount: pr.map(|p| p.discount),
            currency: pr.map(|p| p.currency.clone()),
            stock,
            characteristics,
            status,
            status_note: note,
        });
    }
    Ok(out)
}

fn derive_status(
    rejected: bool,
    has_price: bool,
    prices_synced: bool,
    warehouse_selected: bool,
    stock: Option<i64>,
) -> (String, String) {
    let s = |a: &str, b: &str| (a.to_string(), b.to_string());
    if rejected {
        return s("rejected", "被 WB 拒绝（见卡片错误）");
    }
    if warehouse_selected && stock.unwrap_or(0) <= 0 {
        return s("no_stock", "无库存（补货后可售）");
    }
    if !prices_synced && !has_price {
        return s("price_unknown", "价格未同步（点「同步价格」）");
    }
    if prices_synced && !has_price {
        return s("no_price", "未定价");
    }
    if warehouse_selected {
        (
            "live".into(),
            format!("可售 · 库存 {}", stock.unwrap_or(0)),
        )
    } else {
        s("ok", "已定价（选仓库看库存）")
    }
}

// ── sync metadata (freshness + cooldowns) ────────────────────────────────────

pub fn set_meta(conn: &Connection, key: &str, last_sync_at: i64, status: &str, detail: &str, cooldown_until: i64) -> Result<()> {
    conn.execute(
        "INSERT INTO sync_meta(key,last_sync_at,status,detail,cooldown_until) VALUES(?1,?2,?3,?4,?5)
         ON CONFLICT(key) DO UPDATE SET last_sync_at=excluded.last_sync_at, status=excluded.status,
           detail=excluded.detail, cooldown_until=excluded.cooldown_until",
        params![key, last_sync_at, status, detail, cooldown_until],
    )?;
    Ok(())
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MetaRow {
    pub last_sync_at: i64,
    pub status: String,
    pub detail: String,
    pub cooldown_until: i64,
}

pub fn get_meta(conn: &Connection, key: &str) -> MetaRow {
    conn.query_row(
        "SELECT last_sync_at,status,detail,cooldown_until FROM sync_meta WHERE key=?1",
        params![key],
        |r| {
            Ok(MetaRow {
                last_sync_at: r.get(0)?,
                status: r.get(1)?,
                detail: r.get(2)?,
                cooldown_until: r.get(3)?,
            })
        },
    )
    .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pr(nm: i64, vc: &str, skus: &[&str]) -> ProductRow {
        ProductRow {
            nm_id: nm,
            vendor_code: vc.into(),
            title: format!("Товар {}", nm),
            brand: "Нет бренда".into(),
            subject_id: 1,
            subject_name: "Тест".into(),
            photo: None,
            characteristics: 5,
            skus: skus.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn join_and_status() {
        let mut c = open_memory().unwrap();
        upsert_products(&mut c, &[pr(1, "A", &["bar1"]), pr(2, "B", &["bar2"])], 100, true).unwrap();
        upsert_prices(
            &mut c,
            &[PriceRow { nm_id: 1, price: 1000, discounted_price: 700, discount: 30, currency: "RUB".into() }],
            100,
        )
        .unwrap();
        upsert_stocks(&mut c, 7, &[("bar1".into(), 5)], 100).unwrap();

        // warehouse 7 selected, prices synced
        let cards = get_managed_cards(&c, Some(7), true).unwrap();
        assert_eq!(cards.len(), 2);
        let a = cards.iter().find(|x| x.nm_id == 1).unwrap();
        let b = cards.iter().find(|x| x.nm_id == 2).unwrap();
        // A: priced + stock 5 → live
        assert_eq!(a.status, "live");
        assert_eq!(a.stock, Some(5));
        assert_eq!(a.price, Some(1000));
        // B: no price row, prices synced → no_price (and no stock on wh7)
        assert_eq!(b.stock, Some(0));
        assert_eq!(b.status, "no_stock"); // stock 0 takes precedence over no_price
    }

    #[test]
    fn price_unknown_when_not_synced() {
        let mut c = open_memory().unwrap();
        upsert_products(&mut c, &[pr(1, "A", &["bar1"])], 100, true).unwrap();
        // no warehouse, prices NOT synced → price_unknown (not no_price)
        let cards = get_managed_cards(&c, None, false).unwrap();
        assert_eq!(cards[0].status, "price_unknown");
        assert_eq!(cards[0].stock, None);
    }

    #[test]
    fn rejection_and_account_wipe() {
        let c = {
            let mut c = open_memory().unwrap();
            upsert_products(&mut c, &[pr(1, "A", &["bar1"])], 100, true).unwrap();
            apply_rejections(&c, &["A".to_string()]).unwrap();
            c
        };
        let cards = get_managed_cards(&c, None, true).unwrap();
        assert_eq!(cards[0].status, "rejected");

        // switching account wipes the cache
        ensure_account(&c, "sandbox:123").unwrap();
        let after: i64 = c.query_row("SELECT COUNT(*) FROM products", [], |r| r.get(0)).unwrap();
        assert_eq!(after, 0, "account switch must wipe products");
    }

    #[test]
    fn upsert_removes_stale_products() {
        let mut c = open_memory().unwrap();
        upsert_products(&mut c, &[pr(1, "A", &["a"]), pr(2, "B", &["b"])], 100, true).unwrap();
        // next sync only returns product 1 → product 2 should be dropped
        upsert_products(&mut c, &[pr(1, "A", &["a"])], 200, true).unwrap();
        let n: i64 = c.query_row("SELECT COUNT(*) FROM products", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
    }
}
