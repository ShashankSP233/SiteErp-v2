-- V6.2: Item coding system (SQLite)
CREATE TABLE IF NOT EXISTS item_category (
  cat_code TEXT PRIMARY KEY,
  cat_name TEXT NOT NULL,
  default_label_mode TEXT NOT NULL DEFAULT 'unit' CHECK (default_label_mode IN ('unit','batch')),
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS item_subcategory (
  cat_code TEXT NOT NULL REFERENCES item_category(cat_code),
  sub_code TEXT NOT NULL,
  sub_name TEXT NOT NULL,
  next_serial INTEGER NOT NULL DEFAULT 1,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (cat_code, sub_code)
);
ALTER TABLE items ADD COLUMN cat_code TEXT;
ALTER TABLE items ADD COLUMN sub_code TEXT;
ALTER TABLE items ADD COLUMN serial_no INTEGER;
ALTER TABLE items ADD COLUMN specification TEXT;
ALTER TABLE items ADD COLUMN preferred_make TEXT;
ALTER TABLE items ADD COLUMN oem_part_no TEXT;
ALTER TABLE items ADD COLUMN criticality TEXT;
ALTER TABLE items ADD COLUMN label_mode TEXT NOT NULL DEFAULT 'unit';

INSERT OR IGNORE INTO item_category (cat_code, cat_name, default_label_mode) VALUES
('MEC','Mechanical','unit'),
('ENG','Engines & Propulsion','unit'),
('HYD','Hydraulics','unit'),
('ELE','Electrical','unit'),
('INS','Instrumentation & Automation','unit'),
('DCK','Deck & Marine','unit'),
('PIP','Dredge Pipeline','unit'),
('SVY','Survey Equipment','unit'),
('LUB','Lubricants & Fluids','batch'),
('CON','Consumables','batch'),
('SAF','Safety & PPE','batch'),
('TLS','Tools & Equipment','unit');

INSERT OR IGNORE INTO item_subcategory (cat_code, sub_code, sub_name) VALUES
('MEC','BRG','Bearings'),
('MEC','SEA','Seals & Gaskets'),
('MEC','CPL','Couplings & Drives'),
('MEC','FAS','Fasteners'),
('MEC','WPT','Dredge Wear Parts'),
('MEC','PMP','Pumps (non-hydraulic)'),
('MEC','VLV','Valves'),
('ENG','FIP','Fuel Injection'),
('ENG','TUR','Turbochargers'),
('ENG','PST','Piston & Liner'),
('ENG','CLG','Cooling System'),
('ENG','FLT','Filters'),
('ENG','GBX','Gearbox & Propulsion'),
('HYD','HOS','Hoses & Fittings'),
('HYD','CYL','Cylinders'),
('HYD','HPM','Pumps & Motors'),
('HYD','HVL','Valves & Manifolds'),
('ELE','MOT','Motors & Alternators'),
('ELE','SWG','Switchgear & Panels'),
('ELE','CBL','Cables & Wiring'),
('ELE','LGT','Lighting'),
('ELE','BAT','Batteries & Charging'),
('INS','SEN','Sensors & Gauges'),
('INS','CTL','Control & Automation'),
('DCK','ROP','Ropes & Wires'),
('DCK','ANC','Anchoring & Mooring'),
('DCK','WIN','Winches & Cranes'),
('DCK','NAV','Navigation & Comms'),
('PIP','HDP','HDPE Pipes'),
('PIP','FLO','Floating Hose & Rubber'),
('PIP','BJC','Ball Joints & Couplings'),
('PIP','FLG','Flanges & Bends'),
('SVY','SND','Sounders & Sonar'),
('SVY','GPS','GNSS / Positioning'),
('SVY','SVC','Survey Cables & Access.'),
('LUB','EOL','Engine Oils'),
('LUB','HOL','Hydraulic Oils'),
('LUB','GRS','Greases'),
('LUB','CLT','Coolants & Chemicals'),
('CON','WLD','Welding Consumables'),
('CON','PNT','Paints & Coatings'),
('CON','ADH','Adhesives & Sealants'),
('CON','CLN','Cleaning & General'),
('SAF','PPE','Personal Protective Eqpt.'),
('SAF','LSA','Life Saving Appliances'),
('SAF','FIR','Fire Fighting'),
('SAF','MED','Medical & First Aid'),
('TLS','HND','Hand Tools'),
('TLS','PWR','Power Tools'),
('TLS','LFT','Lifting Tackle'),
('TLS','MSR','Measuring & Testing');
