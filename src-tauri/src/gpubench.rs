// GPU benchmark: the editor's main colour stage (MAIN in engine/src/shaders.js, ported to WGSL by
// engine/src/wgsl-main.js, which passes the source in) on this computer's native GPU API through wgpu
// (Metal on macOS, Vulkan or Direct3D 12 elsewhere), timed the same way the web view's WebGL version
// is. Its result goes in the performance report: whether a native renderer would be faster here, before
// one is built.

use std::time::Instant;

use serde::Serialize;

#[derive(Serialize)]
pub struct Result {
    adapter: String,
    backend: String,
    w: u32,
    h: u32,
    frames: u32,
    ms: f64,
}

// The same pseudo-random photo-like input as the WebGL side: values 0–1.6 (a little over white).
fn noise(w: u32, h: u32, seed: u32) -> Vec<u8> {
    let mut s = seed.wrapping_mul(2654435761).max(1);
    let mut out = Vec::with_capacity((w * h * 8) as usize);
    for _ in 0..w * h * 4 {
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        let v = (s % 1600) as f32 / 1000.0;
        out.extend_from_slice(&crate::raw::float_to_half(v).to_le_bytes());
    }
    out
}

pub fn run(w: u32, h: u32, frames: u32, wgsl: &str, params: &[f32]) -> std::result::Result<Result, String> {
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance,
        ..Default::default()
    }))
    .map_err(|e| e.to_string())?;
    let info = adapter.get_info();
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default())).map_err(|e| e.to_string())?;

    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("main"), source: wgpu::ShaderSource::Wgsl(wgsl.into()) });
    let size = wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 };
    let texture = |usage: wgpu::TextureUsages| {
        device.create_texture(&wgpu::TextureDescriptor {
            label: None,
            size,
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba16Float,
            usage,
            view_formats: &[],
        })
    };
    let input = |seed: u32| {
        let t = texture(wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST);
        queue.write_texture(
            wgpu::TexelCopyTextureInfo { texture: &t, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
            &noise(w, h, seed),
            wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(w * 8), rows_per_image: Some(h) },
            size,
        );
        t
    };
    let (pre, guide) = (input(1), input(2));
    let target = texture(wgpu::TextureUsages::RENDER_ATTACHMENT);
    let mut bytes = Vec::with_capacity(params.len() * 4);
    for p in params {
        bytes.extend_from_slice(&p.to_le_bytes());
    }
    let buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("params"),
        size: bytes.len().max(16) as u64,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    queue.write_buffer(&buffer, 0, &bytes);

    let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("main"),
        layout: None,
        vertex: wgpu::VertexState { module: &module, entry_point: Some("vs"), compilation_options: Default::default(), buffers: &[] },
        primitive: wgpu::PrimitiveState::default(),
        depth_stencil: None,
        multisample: wgpu::MultisampleState::default(),
        fragment: Some(wgpu::FragmentState {
            module: &module,
            entry_point: Some("fs"),
            compilation_options: Default::default(),
            targets: &[Some(wgpu::ColorTargetState { format: wgpu::TextureFormat::Rgba16Float, blend: None, write_mask: wgpu::ColorWrites::ALL })],
        }),
        multiview_mask: None,
        cache: None,
    });
    let (pre_v, guide_v, target_v) = (pre.create_view(&Default::default()), guide.create_view(&Default::default()), target.create_view(&Default::default()));
    let bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: None,
        layout: &pipeline.get_bind_group_layout(0),
        entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: buffer.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&pre_v) },
            wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::TextureView(&guide_v) },
        ],
    });
    // One draw per submission, as the editor's frames are.
    let frame = || {
        let mut enc = device.create_command_encoder(&Default::default());
        {
            let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: None,
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &target_v,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::BLACK), store: wgpu::StoreOp::Store },
                })],
                ..Default::default()
            });
            pass.set_pipeline(&pipeline);
            pass.set_bind_group(0, &bind, &[]);
            pass.draw(0..3, 0..1);
        }
        queue.submit([enc.finish()]);
    };
    let wait = || device.poll(wgpu::PollType::wait_indefinitely()).map(|_| ()).map_err(|e| e.to_string());
    frame();   // compile and warm up
    wait()?;
    let t0 = Instant::now();
    for _ in 0..frames {
        frame();
    }
    wait()?;
    let ms = t0.elapsed().as_secs_f64() * 1000.0 / frames as f64;
    Ok(Result { adapter: info.name, backend: format!("{:?}", info.backend), w, h, frames, ms: (ms * 100.0).round() / 100.0 })
}
