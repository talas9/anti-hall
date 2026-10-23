//! Wire + flow-particle renderers for the Full tier: wgpu (WebGPU) first, Canvas2D when there is no WebGPU.
//! Both draw the same `Frame`; node cards stay DOM. The Lite tier uses neither (static SVG, see view.rs).

use crate::geom::{Cam, Particle};
use wasm_bindgen::JsCast;
use web_sys::{CanvasRenderingContext2d, HtmlCanvasElement};

/// sRGB RGBA 0..1 (not premultiplied).
#[derive(Clone, Copy)]
pub struct Palette {
    pub wire: [f32; 4],
    pub hot: [f32; 4],
    pub particle: [f32; 4],
}

/// One wire to draw: its polyline, whether it is hot, and its width as a multiple of the base width.
pub struct WireRef<'a> {
    pub pts: &'a [[f32; 2]],
    pub hot: bool,
    pub mult: f32,
}

pub struct Frame<'a> {
    pub cam: Cam,
    /// Canvas size in CSS px.
    pub w: f32,
    pub h: f32,
    pub dpr: f32,
    pub wires: &'a [WireRef<'a>],
    pub parts: &'a [Particle],
    pub pal: Palette,
    pub width: f32,
    pub psize: f32,
}

// ---------------------------------------------------------------- Canvas2D

pub struct C2d {
    ctx: CanvasRenderingContext2d,
}

impl C2d {
    pub fn new(canvas: &HtmlCanvasElement) -> Option<Self> {
        let ctx = canvas.get_context("2d").ok()??.dyn_into::<CanvasRenderingContext2d>().ok()?;
        Some(Self { ctx })
    }

    pub fn draw(&self, f: &Frame) {
        let c = &self.ctx;
        let _ = c.set_transform(f.dpr as f64, 0.0, 0.0, f.dpr as f64, 0.0, 0.0);
        c.clear_rect(0.0, 0.0, f.w as f64, f.h as f64);
        let sx = |p: &[f32; 2]| ((p[0] * f.cam.k + f.cam.x) as f64, (p[1] * f.cam.k + f.cam.y) as f64);
        c.set_line_cap("round");
        c.set_line_join("round");
        for w in f.wires {
            c.set_stroke_style_str(&crate::color::rgba_css(if w.hot { f.pal.hot } else { f.pal.wire }));
            c.set_line_width((f.width * w.mult * f.cam.k.max(0.6)) as f64);
            c.begin_path();
            let (x, y) = sx(&w.pts[0]);
            c.move_to(x, y);
            for p in &w.pts[1..] {
                let (x, y) = sx(p);
                c.line_to(x, y);
            }
            c.stroke();
        }
        for hot in [false, true] {
            c.set_fill_style_str(&crate::color::rgba_css(if hot { f.pal.hot } else { f.pal.particle }));
            c.begin_path();
            for p in f.parts.iter().filter(|p| p.hot == hot && p.col.is_none()) {
                let (x, y) = sx(&p.pos);
                let r = (f.psize * f.cam.k.max(0.6)) as f64;
                c.move_to(x + r, y);
                let _ = c.arc(x, y, r, 0.0, std::f64::consts::TAU);
            }
            c.fill();
        }
        for p in f.parts.iter().filter(|p| p.col.is_some()) {
            let Some(col) = p.col else { continue };
            c.set_fill_style_str(&crate::color::rgba_css(col));
            c.begin_path();
            let (x, y) = sx(&p.pos);
            let _ = c.arc(x, y, (f.psize * p.r * f.cam.k.max(0.6)) as f64, 0.0, std::f64::consts::TAU);
            c.fill();
        }
    }
}

// ---------------------------------------------------------------- WebGPU

#[cfg(feature = "full")]
pub use gpu::Gpu;

pub enum Backend {
    #[cfg(feature = "full")]
    Gpu(Gpu),
    C2d(C2d),
}

impl Backend {
    pub fn draw(&mut self, f: &Frame) {
        match self {
            #[cfg(feature = "full")]
            Backend::Gpu(g) => g.draw(f),
            Backend::C2d(c) => c.draw(f),
        }
    }
}

#[cfg(feature = "full")]
mod gpu {
    use super::*;
    use bytemuck::{Pod, Zeroable};
    use wgpu::util::DeviceExt;

    #[repr(C)]
    #[derive(Clone, Copy, Pod, Zeroable)]
    struct Vertex {
        pos: [f32; 2],
        uv: [f32; 2],
        col: [f32; 4],
        /// 0 = line (uv.y is the across-line coordinate), 1 = round particle
        kind: f32,
        _pad: [f32; 3],
    }

    #[repr(C)]
    #[derive(Clone, Copy, Pod, Zeroable)]
    struct Uniforms {
        /// css-px viewport w, h and 1/w, 1/h folded into the shader
        view: [f32; 2],
        _pad: [f32; 2],
    }

    const SHADER: &str = r#"
struct U { view: vec2<f32>, pad: vec2<f32> };
@group(0) @binding(0) var<uniform> u: U;
struct VIn { @location(0) pos: vec2<f32>, @location(1) uv: vec2<f32>, @location(2) col: vec4<f32>, @location(3) kind: f32 };
struct VOut { @builtin(position) p: vec4<f32>, @location(0) uv: vec2<f32>, @location(1) col: vec4<f32>, @location(2) kind: f32 };
@vertex fn vs(v: VIn) -> VOut {
  var o: VOut;
  o.p = vec4<f32>(v.pos.x / u.view.x * 2.0 - 1.0, 1.0 - v.pos.y / u.view.y * 2.0, 0.0, 1.0);
  o.uv = v.uv; o.col = v.col; o.kind = v.kind;
  return o;
}
@fragment fn fs(i: VOut) -> @location(0) vec4<f32> {
  var a: f32;
  if (i.kind < 0.5) { a = 1.0 - smoothstep(0.55, 1.0, abs(i.uv.y)); }
  else { let d = length(i.uv); a = (1.0 - smoothstep(0.35, 1.0, d)) * (1.0 - 0.35 * d); }
  let al = a * i.col.a;
  return vec4<f32>(i.col.rgb * al, al);
}
"#;

    pub struct Gpu {
        surface: wgpu::Surface<'static>,
        device: wgpu::Device,
        queue: wgpu::Queue,
        pipeline: wgpu::RenderPipeline,
        ubuf: wgpu::Buffer,
        bind: wgpu::BindGroup,
        vbuf: wgpu::Buffer,
        cap: usize,
        conf: wgpu::SurfaceConfiguration,
        size: (u32, u32),
    }

    impl Gpu {
        /// `None` when WebGPU is not usable; the canvas is untouched in that case only if `navigator.gpu` was checked first.
        pub async fn new(canvas: HtmlCanvasElement) -> Option<Self> {
            let (w, h) = (canvas.width().max(1), canvas.height().max(1));
            let mut d = wgpu::InstanceDescriptor::new_without_display_handle();
            d.backends = wgpu::Backends::BROWSER_WEBGPU;
            let inst = wgpu::Instance::new(d);
            let surface = inst.create_surface(wgpu::SurfaceTarget::Canvas(canvas)).ok()?;
            let adapter = inst
                .request_adapter(&wgpu::RequestAdapterOptions { compatible_surface: Some(&surface), power_preference: wgpu::PowerPreference::LowPower, ..Default::default() })
                .await
                .ok()?;
            let (device, queue) = adapter.request_device(&wgpu::DeviceDescriptor::default()).await.ok()?;
            let mut conf = surface.get_default_config(&adapter, w, h)?;
            let caps = surface.get_capabilities(&adapter);
            if caps.alpha_modes.contains(&wgpu::CompositeAlphaMode::PreMultiplied) {
                conf.alpha_mode = wgpu::CompositeAlphaMode::PreMultiplied;
            }
            surface.configure(&device, &conf);
            let sm = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: None, source: wgpu::ShaderSource::Wgsl(SHADER.into()) });
            let ubuf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: None,
                contents: bytemuck::bytes_of(&Uniforms { view: [w as f32, h as f32], _pad: [0.0; 2] }),
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            });
            let bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: None,
                entries: &[wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::VERTEX,
                    ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None },
                    count: None,
                }],
            });
            let bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: None,
                layout: &bgl,
                entries: &[wgpu::BindGroupEntry { binding: 0, resource: ubuf.as_entire_binding() }],
            });
            let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: None, bind_group_layouts: &[Some(&bgl)], immediate_size: 0 });
            let attrs = wgpu::vertex_attr_array![0 => Float32x2, 1 => Float32x2, 2 => Float32x4, 3 => Float32];
            let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: None,
                layout: Some(&layout),
                vertex: wgpu::VertexState {
                    module: &sm,
                    entry_point: Some("vs"),
                    buffers: &[Some(wgpu::VertexBufferLayout { array_stride: std::mem::size_of::<Vertex>() as u64, step_mode: wgpu::VertexStepMode::Vertex, attributes: &attrs })],
                    compilation_options: Default::default(),
                },
                fragment: Some(wgpu::FragmentState {
                    module: &sm,
                    entry_point: Some("fs"),
                    targets: &[Some(wgpu::ColorTargetState { format: conf.format, blend: Some(wgpu::BlendState::PREMULTIPLIED_ALPHA_BLENDING), write_mask: wgpu::ColorWrites::ALL })],
                    compilation_options: Default::default(),
                }),
                primitive: Default::default(),
                depth_stencil: None,
                multisample: Default::default(),
                multiview_mask: None,
                cache: None,
            });
            let cap = 4096;
            let vbuf = Self::vbuf(&device, cap);
            Some(Self { surface, device, queue, pipeline, ubuf, bind, vbuf, cap, conf, size: (w, h) })
        }

        fn vbuf(device: &wgpu::Device, cap: usize) -> wgpu::Buffer {
            device.create_buffer(&wgpu::BufferDescriptor {
                label: None,
                size: (cap * std::mem::size_of::<Vertex>()) as u64,
                usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            })
        }

        pub fn draw(&mut self, f: &Frame) {
            let px = ((f.w * f.dpr) as u32).max(1);
            let py = ((f.h * f.dpr) as u32).max(1);
            if (px, py) != self.size {
                self.size = (px, py);
                self.conf.width = px;
                self.conf.height = py;
                self.surface.configure(&self.device, &self.conf);
            }
            self.queue.write_buffer(&self.ubuf, 0, bytemuck::bytes_of(&Uniforms { view: [f.w, f.h], _pad: [0.0; 2] }));
            let verts = tessellate(f);
            if verts.len() > self.cap {
                self.cap = verts.len().next_power_of_two();
                self.vbuf = Self::vbuf(&self.device, self.cap);
            }
            if !verts.is_empty() {
                self.queue.write_buffer(&self.vbuf, 0, bytemuck::cast_slice(&verts));
            }
            let tex = match self.surface.get_current_texture() {
                wgpu::CurrentSurfaceTexture::Success(t) | wgpu::CurrentSurfaceTexture::Suboptimal(t) => t,
                wgpu::CurrentSurfaceTexture::Outdated | wgpu::CurrentSurfaceTexture::Lost => {
                    self.surface.configure(&self.device, &self.conf);
                    return;
                }
                _ => return,
            };
            let view = tex.texture.create_view(&Default::default());
            let mut enc = self.device.create_command_encoder(&Default::default());
            {
                let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: None,
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view: &view,
                        depth_slice: None,
                        resolve_target: None,
                        ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT), store: wgpu::StoreOp::Store },
                    })],
                    depth_stencil_attachment: None,
                    timestamp_writes: None,
                    occlusion_query_set: None,
                    multiview_mask: None,
                });
                if !verts.is_empty() {
                    pass.set_pipeline(&self.pipeline);
                    pass.set_bind_group(0, &self.bind, &[]);
                    pass.set_vertex_buffer(0, self.vbuf.slice(..(verts.len() * std::mem::size_of::<Vertex>()) as u64));
                    pass.draw(0..verts.len() as u32, 0..1);
                }
            }
            self.queue.submit([enc.finish()]);
            self.queue.present(tex);
        }
    }

    fn vert(pos: [f32; 2], uv: [f32; 2], col: [f32; 4], kind: f32) -> Vertex {
        Vertex { pos, uv, col, kind, _pad: [0.0; 3] }
    }

    /// Thick polylines -> quads (one per segment, antialiased in the fragment shader), particles -> quads.
    fn tessellate(f: &Frame) -> Vec<Vertex> {
        let k = f.cam.k;
        let sx = |p: &[f32; 2]| [p[0] * k + f.cam.x, p[1] * k + f.cam.y];
        let mut v = Vec::new();
        for w in f.wires {
            let half = f.width * w.mult * k.max(0.6) * 0.5 + 0.75;
            let col = if w.hot { f.pal.hot } else { f.pal.wire };
            for s in w.pts.windows(2) {
                let (a, b) = (sx(&s[0]), sx(&s[1]));
                let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
                let len = (dx * dx + dy * dy).sqrt().max(1e-4);
                let (nx, ny) = (-dy / len * half, dx / len * half);
                let (a0, a1, b0, b1) = ([a[0] + nx, a[1] + ny], [a[0] - nx, a[1] - ny], [b[0] + nx, b[1] + ny], [b[0] - nx, b[1] - ny]);
                for (p, y) in [(a0, 1.0), (a1, -1.0), (b0, 1.0), (b0, 1.0), (a1, -1.0), (b1, -1.0)] {
                    v.push(vert(p, [0.0, y], col, 0.0));
                }
            }
        }
        for p in f.parts {
            let r = f.psize * p.r * k.max(0.6) * 2.2;
            let c = sx(&p.pos);
            let col = p.col.unwrap_or(if p.hot { f.pal.hot } else { f.pal.particle });
            for (dx, dy) in [(-1.0, -1.0), (1.0, -1.0), (-1.0, 1.0), (-1.0, 1.0), (1.0, -1.0), (1.0, 1.0f32)] {
                v.push(vert([c[0] + dx * r, c[1] + dy * r], [dx, dy], col, 1.0));
            }
        }
        v
    }
}

/// True when WebGPU hands out an adapter. Probed through JS before wgpu touches the canvas: creating a `webgpu` context and
/// then failing would leave the canvas unusable for 2D.
pub async fn webgpu_available() -> bool {
    let Some(w) = web_sys::window() else { return false };
    let nav = w.navigator();
    let Ok(gpu) = js_sys::Reflect::get(&nav, &"gpu".into()) else { return false };
    if gpu.is_undefined() || gpu.is_null() {
        return false;
    }
    let Ok(f) = js_sys::Reflect::get(&gpu, &"requestAdapter".into()) else { return false };
    let Ok(f) = f.dyn_into::<js_sys::Function>() else { return false };
    let Ok(p) = f.call0(&gpu) else { return false };
    let Ok(p) = p.dyn_into::<js_sys::Promise>() else { return false };
    matches!(wasm_bindgen_futures::JsFuture::from(p).await, Ok(v) if !v.is_null() && !v.is_undefined())
}
