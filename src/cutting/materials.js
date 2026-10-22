// Workpiece materials for the cutting-force model.
//
// Generated from Shop-Ref's MaterialLibrary.kt (core/material), so the two
// apps agree on every number. Kienzle constants kc1.1 [N/mm²] and mc are
// typical literature values for a 0° rake reference (Sandvik Coromant CMC/ISO
// tables; König & Essel 1973); the friction angle drives the radial and axial
// force ratios. Speeds and chip loads are catalogue starting points, used here
// only to say whether a cut is light or heavy for the material.

export const MATERIALS = [
  { id: "p_low_carbon", name: "Low-carbon steel", group: "P", family: "STEEL", examples: "1018, 1020, A36, S235JR, C15", hardness: "≈130 HB", kc11: 1400.0, mc: 0.22, frictionAngle: 28.0, vcCarbide: 120.0, vcHss: 30.0, fzPerD: 0.005 },
  { id: "p_free_machining", name: "Free-machining steel", group: "P", family: "STEEL", examples: "12L14, 1215, 11SMnPb30", hardness: "≈150 HB", kc11: 1250.0, mc: 0.22, frictionAngle: 26.0, vcCarbide: 160.0, vcHss: 45.0, fzPerD: 0.006 },
  { id: "p_medium_carbon", name: "Medium-carbon steel", group: "P", family: "STEEL", examples: "1045, 1050, C45, S355", hardness: "≈180 HB", kc11: 1500.0, mc: 0.22, frictionAngle: 28.0, vcCarbide: 100.0, vcHss: 25.0, fzPerD: 0.0045 },
  { id: "p_alloy_annealed", name: "Alloy steel, annealed", group: "P", family: "STEEL", examples: "4140, 4340, 8620, 42CrMo4, 16MnCr5", hardness: "≈200 HB", kc11: 1700.0, mc: 0.24, frictionAngle: 28.0, vcCarbide: 95.0, vcHss: 22.0, fzPerD: 0.0045 },
  { id: "p_alloy_prehard", name: "Alloy steel, pre-hardened", group: "P", family: "STEEL", examples: "4140 PH, P20, 42CrMo4+QT", hardness: "28–32 HRC (≈300 HB)", kc11: 1900.0, mc: 0.24, frictionAngle: 29.0, vcCarbide: 75.0, vcHss: 15.0, fzPerD: 0.004 },
  { id: "p_alloy_qt", name: "Alloy steel, quenched & tempered", group: "P", family: "STEEL", examples: "4340 HT, 4140 HT, 34CrNiMo6", hardness: "35–40 HRC (≈350 HB)", kc11: 2100.0, mc: 0.24, frictionAngle: 30.0, vcCarbide: 60.0, vcHss: 10.0, fzPerD: 0.0035 },
  { id: "p_tool_annealed", name: "Tool steel, annealed", group: "P", family: "STEEL", examples: "A2, O1, S7, H13, 1.2344", hardness: "≈220 HB", kc11: 1900.0, mc: 0.24, frictionAngle: 29.0, vcCarbide: 75.0, vcHss: 15.0, fzPerD: 0.004 },
  { id: "p_tool_d2", name: "High-chrome tool steel, annealed", group: "P", family: "STEEL", examples: "D2, D3, 1.2379, X153CrMoV12", hardness: "≈250 HB", kc11: 2100.0, mc: 0.24, frictionAngle: 30.0, vcCarbide: 55.0, vcHss: 10.0, fzPerD: 0.0035 },
  { id: "p_cast_steel", name: "Cast steel", group: "P", family: "STEEL", examples: "GS-45, WCB, 1.0619", hardness: "≈180 HB", kc11: 1600.0, mc: 0.24, frictionAngle: 28.0, vcCarbide: 90.0, vcHss: 20.0, fzPerD: 0.0045 },
  { id: "m_303", name: "Free-machining stainless", group: "M", family: "STAINLESS", examples: "303, 416, 1.4305", hardness: "≈180 HB", kc11: 1900.0, mc: 0.2, frictionAngle: 31.0, vcCarbide: 100.0, vcHss: 25.0, fzPerD: 0.0045 },
  { id: "m_austenitic", name: "Austenitic stainless", group: "M", family: "STAINLESS", examples: "304, 304L, 316, 316L, 321, 1.4301, 1.4404", hardness: "≈180 HB", kc11: 2150.0, mc: 0.2, frictionAngle: 32.0, vcCarbide: 70.0, vcHss: 15.0, fzPerD: 0.004 },
  { id: "m_martensitic", name: "Martensitic/ferritic stainless, annealed", group: "M", family: "STAINLESS", examples: "410, 420, 430, 440C (ann.), 1.4021", hardness: "≈200 HB", kc11: 1800.0, mc: 0.21, frictionAngle: 30.0, vcCarbide: 90.0, vcHss: 20.0, fzPerD: 0.0045 },
  { id: "m_ph_h1150", name: "PH stainless, overaged", group: "M", family: "STAINLESS", examples: "17-4 PH H1150, 15-5 PH H1150", hardness: "≈30 HRC (≈300 HB)", kc11: 2300.0, mc: 0.21, frictionAngle: 31.0, vcCarbide: 60.0, vcHss: 12.0, fzPerD: 0.0038 },
  { id: "m_ph_h900", name: "PH stainless, peak aged", group: "M", family: "STAINLESS", examples: "17-4 PH H900, 13-8 Mo", hardness: "≈42 HRC (≈400 HB)", kc11: 2600.0, mc: 0.21, frictionAngle: 32.0, vcCarbide: 45.0, vcHss: 8.0, fzPerD: 0.003 },
  { id: "m_duplex", name: "Duplex stainless", group: "M", family: "STAINLESS", examples: "2205, 2507, 1.4462", hardness: "≈250 HB", kc11: 2300.0, mc: 0.21, frictionAngle: 32.0, vcCarbide: 55.0, vcHss: 10.0, fzPerD: 0.0035 },
  { id: "k_grey_low", name: "Grey cast iron", group: "K", family: "CAST_IRON", examples: "Class 30, EN-GJL-250, GG-25", hardness: "≈200 HB", kc11: 1150.0, mc: 0.2, frictionAngle: 24.0, vcCarbide: 120.0, vcHss: 30.0, fzPerD: 0.005 },
  { id: "k_grey_high", name: "Grey cast iron, high tensile", group: "K", family: "CAST_IRON", examples: "Class 40/50, EN-GJL-300/350", hardness: "≈240 HB", kc11: 1350.0, mc: 0.28, frictionAngle: 25.0, vcCarbide: 100.0, vcHss: 22.0, fzPerD: 0.0045 },
  { id: "k_ductile", name: "Ductile (nodular) iron", group: "K", family: "CAST_IRON", examples: "65-45-12, 80-55-06, EN-GJS-500, GGG-50", hardness: "≈200 HB", kc11: 1350.0, mc: 0.25, frictionAngle: 27.0, vcCarbide: 100.0, vcHss: 25.0, fzPerD: 0.0045 },
  { id: "k_cgi", name: "Compacted graphite iron", group: "K", family: "CAST_IRON", examples: "CGI, EN-GJV-450", hardness: "≈230 HB", kc11: 1500.0, mc: 0.25, frictionAngle: 27.0, vcCarbide: 80.0, vcHss: 18.0, fzPerD: 0.004 },
  { id: "n_al_wrought", name: "Aluminium, wrought", group: "N", family: "ALUMINUM", examples: "6061-T6, 6082, 5083, 2024", hardness: "≈95 HB", kc11: 600.0, mc: 0.25, frictionAngle: 32.0, vcCarbide: 350.0, vcHss: 100.0, fzPerD: 0.01 },
  { id: "n_al_7075", name: "Aluminium, high-strength", group: "N", family: "ALUMINUM", examples: "7075-T6, 7050-T7451, 2014", hardness: "≈150 HB", kc11: 700.0, mc: 0.25, frictionAngle: 31.0, vcCarbide: 330.0, vcHss: 90.0, fzPerD: 0.0095 },
  { id: "n_al_cast", name: "Aluminium, cast (<12% Si)", group: "N", family: "ALUMINUM", examples: "A356, 356-T6, AlSi7Mg, MIC-6", hardness: "≈80 HB", kc11: 650.0, mc: 0.25, frictionAngle: 30.0, vcCarbide: 250.0, vcHss: 80.0, fzPerD: 0.008 },
  { id: "n_al_high_si", name: "Aluminium, high-silicon cast", group: "N", family: "ALUMINUM", examples: "A390, AlSi17Cu4", hardness: "≈120 HB", kc11: 800.0, mc: 0.25, frictionAngle: 28.0, vcCarbide: 150.0, vcHss: 40.0, fzPerD: 0.006 },
  { id: "n_magnesium", name: "Magnesium alloy", group: "N", family: "MAGNESIUM", examples: "AZ31B, AZ91D", hardness: "≈60 HB", kc11: 350.0, mc: 0.25, frictionAngle: 28.0, vcCarbide: 400.0, vcHss: 150.0, fzPerD: 0.01 },
  { id: "n_brass", name: "Brass, free-cutting", group: "N", family: "COPPER", examples: "C360, CW614N, CuZn39Pb3", hardness: "≈90 HB", kc11: 700.0, mc: 0.25, frictionAngle: 24.0, vcCarbide: 300.0, vcHss: 100.0, fzPerD: 0.008 },
  { id: "n_copper", name: "Copper, pure", group: "N", family: "COPPER", examples: "C101, C110, Cu-ETP, Cu-OF", hardness: "≈90 HB", kc11: 1750.0, mc: 0.25, frictionAngle: 36.0, vcCarbide: 200.0, vcHss: 60.0, fzPerD: 0.006 },
  { id: "n_bronze", name: "Bronze, bearing/leaded", group: "N", family: "COPPER", examples: "C932 (SAE 660), C936, CuSn7ZnPb", hardness: "≈70 HB", kc11: 1000.0, mc: 0.25, frictionAngle: 26.0, vcCarbide: 180.0, vcHss: 50.0, fzPerD: 0.006 },
  { id: "n_al_bronze", name: "Aluminium bronze", group: "N", family: "COPPER", examples: "C954, C630, CuAl10Fe5Ni5", hardness: "≈170 HB", kc11: 1600.0, mc: 0.25, frictionAngle: 30.0, vcCarbide: 100.0, vcHss: 30.0, fzPerD: 0.0045 },
  { id: "n_acetal", name: "Acetal (POM)", group: "N", family: "PLASTIC", examples: "Delrin, POM-C, POM-H", hardness: "≈85 Shore D", kc11: 200.0, mc: 0.3, frictionAngle: 25.0, vcCarbide: 300.0, vcHss: 150.0, fzPerD: 0.012 },
  { id: "n_nylon", name: "Nylon / UHMW-PE", group: "N", family: "PLASTIC", examples: "PA6, PA66, UHMW", hardness: "≈75 Shore D", kc11: 180.0, mc: 0.3, frictionAngle: 25.0, vcCarbide: 250.0, vcHss: 120.0, fzPerD: 0.012 },
  { id: "n_peek", name: "PEEK / engineering plastics", group: "N", family: "PLASTIC", examples: "PEEK, PEI (Ultem), PPS", hardness: "≈85 Shore D", kc11: 300.0, mc: 0.3, frictionAngle: 27.0, vcCarbide: 200.0, vcHss: 100.0, fzPerD: 0.008 },
  { id: "n_acrylic", name: "Acrylic / polycarbonate", group: "N", family: "PLASTIC", examples: "PMMA, PC (Lexan)", hardness: "≈90 Shore D", kc11: 220.0, mc: 0.3, frictionAngle: 25.0, vcCarbide: 250.0, vcHss: 120.0, fzPerD: 0.01 },
  { id: "n_g10", name: "Glass-epoxy laminate", group: "N", family: "COMPOSITE", examples: "G10, FR4, GFRP", hardness: "abrasive", kc11: 500.0, mc: 0.3, frictionAngle: 25.0, vcCarbide: 150.0, vcHss: 0.0, fzPerD: 0.006 },
  { id: "n_cfrp", name: "Carbon-fibre composite", group: "N", family: "COMPOSITE", examples: "CFRP prepreg, carbon plate", hardness: "abrasive", kc11: 600.0, mc: 0.3, frictionAngle: 25.0, vcCarbide: 150.0, vcHss: 0.0, fzPerD: 0.005 },
  { id: "n_graphite", name: "Graphite", group: "N", family: "GRAPHITE", examples: "EDM graphite", hardness: "≈60 Shore", kc11: 150.0, mc: 0.3, frictionAngle: 22.0, vcCarbide: 300.0, vcHss: 0.0, fzPerD: 0.005 },
  { id: "s_ti_cp", name: "Titanium, commercially pure", group: "S", family: "TITANIUM", examples: "Grade 2, Grade 4", hardness: "≈200 HB", kc11: 1300.0, mc: 0.23, frictionAngle: 26.0, vcCarbide: 60.0, vcHss: 18.0, fzPerD: 0.0045 },
  { id: "s_ti64", name: "Titanium alloy", group: "S", family: "TITANIUM", examples: "Ti-6Al-4V (Grade 5), Ti-6Al-4V ELI", hardness: "≈330 HB (36 HRC)", kc11: 1450.0, mc: 0.23, frictionAngle: 26.0, vcCarbide: 45.0, vcHss: 10.0, fzPerD: 0.004 },
  { id: "s_inconel_718", name: "Nickel alloy, aged", group: "S", family: "NICKEL", examples: "Inconel 718, Waspaloy, Rene 41", hardness: "≈40 HRC (≈380 HB)", kc11: 3300.0, mc: 0.25, frictionAngle: 30.0, vcCarbide: 20.0, vcHss: 4.0, fzPerD: 0.003 },
  { id: "s_inconel_625", name: "Nickel alloy, solution treated", group: "S", family: "NICKEL", examples: "Inconel 625, 600, Monel 400, Hastelloy C-276", hardness: "≈200 HB", kc11: 2900.0, mc: 0.25, frictionAngle: 31.0, vcCarbide: 25.0, vcHss: 6.0, fzPerD: 0.0032 },
  { id: "s_cobalt", name: "Cobalt-chrome alloy", group: "S", family: "NICKEL", examples: "CoCrMo (F75/F1537), Stellite 6", hardness: "≈35 HRC", kc11: 3100.0, mc: 0.25, frictionAngle: 31.0, vcCarbide: 20.0, vcHss: 0.0, fzPerD: 0.0028 },
  { id: "h_45_50", name: "Hardened steel 45–50 HRC", group: "H", family: "HARDENED", examples: "4140/4340 hardened, H13 47 HRC, 1.2343", hardness: "45–50 HRC", kc11: 3000.0, mc: 0.25, frictionAngle: 31.0, vcCarbide: 50.0, vcHss: 0.0, fzPerD: 0.003 },
  { id: "h_50_55", name: "Hardened steel 50–55 HRC", group: "H", family: "HARDENED", examples: "S7, A2 hardened, 1.2363", hardness: "50–55 HRC", kc11: 3500.0, mc: 0.25, frictionAngle: 32.0, vcCarbide: 40.0, vcHss: 0.0, fzPerD: 0.0025 },
  { id: "h_55_60", name: "Hardened steel 55–60 HRC", group: "H", family: "HARDENED", examples: "D2, A2, O1, 52100 hardened", hardness: "55–60 HRC", kc11: 4000.0, mc: 0.25, frictionAngle: 32.0, vcCarbide: 30.0, vcHss: 0.0, fzPerD: 0.002 },
  { id: "h_60_65", name: "Hardened steel 60–65 HRC", group: "H", family: "HARDENED", examples: "M2, D2 62 HRC, PM tool steels, chilled cast iron", hardness: "60–65 HRC", kc11: 4600.0, mc: 0.25, frictionAngle: 33.0, vcCarbide: 22.0, vcHss: 0.0, fzPerD: 0.0015 },
];

/** By id; the default is the commonest bar in a job shop. */
export const DEFAULT_MATERIAL = 'n_al_wrought';

export function materialById(id) {
  return MATERIALS.find((m) => m.id === id) || MATERIALS.find((m) => m.id === DEFAULT_MATERIAL) || MATERIALS[0];
}

/** Rake angle a cutter for this material is typically ground with, deg (Shop-Ref defaultRake). */
export function defaultRake(m) {
  switch (m.family) {
    case 'ALUMINUM': case 'MAGNESIUM': case 'PLASTIC': return 15;
    case 'COPPER': return m.id === 'n_brass' ? 0 : 10;
    case 'STEEL': return 8;
    case 'STAINLESS': return 10;
    case 'CAST_IRON': return 6;
    case 'TITANIUM': return 10;
    case 'NICKEL': return 8;
    case 'HARDENED': return -2;
    case 'COMPOSITE': return 10;
    case 'GRAPHITE': return 5;
    default: return 8;
  }
}
