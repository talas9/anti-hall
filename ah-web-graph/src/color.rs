//! OKLCH -> sRGB. The theme tokens are OKLCH strings (CSS uses them as-is); the canvas and GPU layers need RGB floats.
//! Björn Ottosson's OKLab matrices; ~20 lines, so no colour crate in the bundle.

/// Parse `oklch(L C H)` (L 0..1 or `NN%`, H degrees, optional `/ alpha`). Returns linear-light-free sRGB [r,g,b,a] in 0..1.
pub fn parse_oklch(s: &str) -> Option<[f32; 4]> {
    let inner = s.trim().strip_prefix("oklch(")?.strip_suffix(')')?;
    let (main, alpha) = match inner.split_once('/') {
        Some((m, a)) => (m, parse_num(a.trim())?),
        None => (inner, 1.0),
    };
    let mut it = main.split_whitespace();
    let l = parse_num(it.next()?)?;
    let c = parse_num(it.next()?)?;
    let h = it.next()?.trim_end_matches("deg").parse::<f32>().ok()?;
    let [r, g, b] = oklch_to_srgb(l, c, h);
    Some([r, g, b, alpha])
}

fn parse_num(t: &str) -> Option<f32> {
    match t.strip_suffix('%') {
        Some(p) => p.trim().parse::<f32>().ok().map(|v| v / 100.0),
        None => t.parse::<f32>().ok(),
    }
}

pub fn oklch_to_srgb(l: f32, c: f32, h_deg: f32) -> [f32; 3] {
    let h = h_deg.to_radians();
    let (a, b) = (c * h.cos(), c * h.sin());
    let l_ = l + 0.396_337_78 * a + 0.215_803_76 * b;
    let m_ = l - 0.105_561_346 * a - 0.063_854_17 * b;
    let s_ = l - 0.089_484_18 * a - 1.291_485_5 * b;
    let (l3, m3, s3) = (l_ * l_ * l_, m_ * m_ * m_, s_ * s_ * s_);
    let lin = [
        4.076_741_7 * l3 - 3.307_711_6 * m3 + 0.230_969_93 * s3,
        -1.268_438 * l3 + 2.609_757_4 * m3 - 0.341_319_4 * s3,
        -0.004_196_086 * l3 - 0.703_418_6 * m3 + 1.707_614_7 * s3,
    ];
    lin.map(|v| {
        let v = v.clamp(0.0, 1.0);
        if v <= 0.003_130_8 { 12.92 * v } else { 1.055 * v.powf(1.0 / 2.4) - 0.055 }
    })
}

pub fn rgba_css(c: [f32; 4]) -> String {
    format!("rgba({},{},{},{})", (c[0] * 255.0).round(), (c[1] * 255.0).round(), (c[2] * 255.0).round(), c[3])
}
