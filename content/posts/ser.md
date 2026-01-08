+++
title = '(Ab)using Shader Execution Reordering'
date = 2026-01-07T14:27:41+01:00
draft = false
Summary = 'Notes on creative usage of shader execution reordering'
+++

{{< figure src="/ser.png" width="100%" >}}

## Introduction

This post is a note on some outside-the-beaten-path experiment I did with Shader Execution Reordering (SER).

After a short introduction into SER, I will detail how I used (abused?) it in order to achieved a form of shading level of detail in an Optix based testbed.

> The GPU I have available at home is a RTX3090. The keen under you will directly notice that while technically this card support SER on an API level, it does not on a hardware level. This means a lot of things but mostly I cannot make any performance related claims or notes. All of this is a purely an fun "would this work?" style experiment (so do your due diligence if you are actually considering of using this).


## Shader Execution Reordering

SER is a relatively new concept in hardware raytracing and was introduced as a performance optimization. When RT was introduced in modern graphics APIs, It was very easy to trace rays. Sure, there was (and still is) a ton of work required to do efficient BVH and SBT builds, but tracing the rays itself was trivial. With a single call you can setup a ray, traverse the BVH and invoke one or multiple shaders upon hit/miss/intersection/... This is super simple to use but makes it a bit of a monolithic black box. Black boxes are not necessarily a bad thing imho but the monolithic 'huge chunk of work' can be. As rays hit different objects, they might invoke different shaders, sample different textures, make slightly different lightcuts,... All of that causes threads to have slightly different behavior both in terms of what to do (execution divergence) and what is required to do it (data divergence). The elephant in the room is GPUs do not like divergence at all due to how they are architected. Careers are build on the concept of keeping GPU divergence as low as possible (with performance in return), so SER was introduced to improve this.

SER divided this TraceRay call back up into smaller subtasks. Just like before, we still setup a ray, traverse the BVH and invoke any shaders upon the outcome of that. The big difference is that BVH traversal and shader invocation are now 2 separate stages (but they are still exactly the same as before). A new reordering stage sits in between the traversal and shader invocation. It will sort/bucket the hit results before starting the invocation stage. This should ensures that rays that hit (or miss) the same object are grouped together and so do their shader invocation in the same warp/wavefront/... Obviously there is a lot of handwaving due to hardware implementation details here but we aim for "rays that hit roughly the same object/material/... should be processed together so we can exploit this coherency". All this sorting/bucketing is of course not free but in general, this should give a nice boost in performance due to improved data and execution divergence. 

The exact key used to sort hit results is (afaik at least) not really defined and so implementation defined. But in general we can expect things like what we hit (SBT and primitive index), the ray properties (origin and direction) and some user specified bits to be part of it. These user bits can be very useful as of course we (should?) know better what we are doing and so how to guide this.

Having traversal and shader invocation split up also allows us to simplify some algorithms. Shadow rays or ambient occlusion queries typically only care if they hit something rather then what exactly it was. By using SER, we can only do the traversal step and completely ignore the reordering and/or shader stage.

## (Ab)Using SER

When reading up on this new SER apis, one question immediately in the back of my mind formed: "If we can provide hints for the sorting, it must mean we have some form of write access to the hit results? What else can we change here?". Well as it turns out, we can change pretty much everything here (well at least depending on the API, more on this later). So after months of procrastination, I set off on a quest to have a proof of concept.

I ended up with a small Optix based renderer that does some trivial environment map lighting. There is nothing special happening here: just take a few samples on the hemisphere around the primary hit normal and sample a latlong environment map. This is weighted by visibility of course (more rays!) but nothing more advanced like importance sampling is used.

Next up I made a crude approximation[^1] of this environment map lighting. It used a prebuilt table, still requires a visibility ray but it only takes a single 'sample'. So rather then X texture samples (along X visibility rays), this approximation uses a single visibility ray and a load from that small prebuilt table. While quality is far from perfect, it is good enough for this test case as I was only after a crude approximation.

[^1]: I create a 32*16 octahedral mapped buffer. Each cell is initialized with 4k random 'rays' around that octahedral normal (stratified so cover the whole 'tile'). For each 'ray', I simple sample the environment map and average it. I store the results as a single float4 but probably something smarter is possible here. At runtime, I construct a random direction inside a 30 degree cone around the hit normal. Based on that direction, I do the inverse octahedral mapping and load the value we precomputed earlier. That 30 degree cone is pretty empirically decided but it does tend to sample a bit outside the normal octahedral tile so we have some bleeding across cells. I am not sure if I cooked up something new, rediscovered something already described in the 80s or it totally bonkers and it just happens to work in my very limited testcase.

{{< figure src="/hq.png" caption="Regular environment lighting" width="45%" inline="true" >}}
{{< figure src="/lq.png" caption="Our crude approximation" width="45%" inline="true" >}}

So now armed with two techniques that both do (a form off) environment map lighting, let try to select one or the other solution based on the distance from the camera. This should give us a shading/lighting LOD where we use the expensive high quality techniques on hits close to the camera while having a 'good enough' fallback for the rest of the scene. It is important to highlight that we want this selection to be per hit and not per-instance: even inside a single triangle, we want to hits closer to us to use the HQ version. Ofcourse there are various solutions on how to implement this LOD but remember, we want to use SER here!

The first bit of work we need to do is give our geometry multiple SBT hit records. This is actually quite trivial using Optix: simply increase _numSbtRecords_ in _OptixBuildInputTriangleArray_ during BLAS builds (this requires some more patching like custom IndexOffsetBuffer but that is equally trivial). We also need to add an additional closest hit record in the SBT build. The first hit records will point to a kernel that does the traditional 'HQ' env mapping and the second to our approximation kernel. Important note here is that these closest hit functions are totally isolated from each other. They might share some code but both are compiled independently: optimizations and registry pressure are all "optimal" (as opposed to for example uber shader solutions). 

```
SBT Layout
    |-------------------|----------------------|----------------------|----------------------|
    | RayGen Record     | ClosestHit Record 0  | Closest Hit Record 1 | Miss Record          |
    |-------------------|----------------------|----------------------|----------------------|
    | Primary Ray + SER | HQ Env Map Kernel    | Approximation Kernel | Envnmap fallback     |
    |                   |                      |                      |                      |
    |-------------------|----------------------|----------------------|----------------------|
```

When we now trace primary rays, we can simply offset the SBT index of the HitObject based on some heuristics and parameters. I use a simple distance to the camera with some stochastic dithering to ease the transition. But the sky is pretty much the limit here, anything you can cook up to make the decision what shader to select is possible (screen position, primitive index, instance, ...). And that is pretty much it! Once you are passed the random crashes and corruption (SBTs can be tricky), it is actually pretty simple and clean. 

```c
optixTraverse(params.handle, ray_origin, ray_direction, params.scene_epsilon, 1e16f, 0.0f,
    OptixVisibilityMask(1), OPTIX_RAY_FLAG_NONE, 0, 1, 0, rayPayload.x, rayPayload.y);  
if (optixHitObjectIsHit())
{
    int sbtIdx = selectSBT(); 

    // Make a new HitRecord (by basically just copying over most params from the initial one)
    optixMakeHitObjectWithRecord(
        params.handle,
        optixHitObjectGetWorldRayOrigin(), optixHitObjectGetWorldRayDirection(), optixHitObjectGetRayTmin(), optixHitObjectGetRayTmax(), optixHitObjectGetRayTime(),
        sbtIdx,
        optixHitObjectGetInstanceIndex(),
        nullptr, 0,
        optixHitObjectGetSbtGASIndex(), optixHitObjectGetPrimitiveIndex(), optixHitObjectGetHitKind(),
        optixHitObjectGetAttribute_0(), optixHitObjectGetAttribute_1(), optixHitObjectGetAttribute_2());
}
optixReorder();
optixInvoke(rayPayload.x, rayPayload.y);
```

{{< figure src="/ser.png" alt="targets HQ" caption="Blending our two lighting modes using SER" width="45%" inline="true">}}
{{< figure src="/debug.png" alt="targets" caption="Debug visualization that highlights were we are using the approximation" width="45%" inline="true">}}

## Now what?

All of this seems to work just fine using Optix (on my PC 😏 ) but what about other APIs? Optix has these explicit _MakeHitObject_ functions that are perfect for this. DirectX and Vulkan both provide functions to modify the SBT hit index (_HitObject::SetShaderTableIndex_ and _hitObjectSetShaderBindingTableRecordIndexEXT_) though it does feel a bit more limited. For example Optix seems to be able to construct HitObject from thin air (without doing a optixTraverse first) while these other APIs are a bit more restrictive? Well at least that what is seems like from reading the spec, I have not actually tried anything besides Optix so who knows what dragons are hiding there.

Even if we can have a cross API solution here, would we care? Sure it is cool to play with but can it be really practical outside these artificial setups? Maybe or maybe not, I am not sure where we go from here. It has been a fun experiment but a lot more effort will be needed if we ever going to use something like this in production. Or perhaps somebody already tried and it failed horrible? Probably most of you distinguished readers can think of various reasons how this could be used or why this is a great/horrible/cool-but-no idea.

One idea I had around all this SER was during one of [the awesome DOOM talks at GPC25](https://graphicsprogrammingconference.com/archive/2025#visibility-buffer-and-deferred-rendering-in-doom-the-dark-ages). They implemented a system that uses compute shaders to do deferred texturing and lighting. In order to optimize performance, they had to build various subsystems like tile classification, pixel command buffers, indirect dispatches and more. All so they can reduce divergence when processing pixels that "roughly do the same thing". Sounds familiar? In an era where most of our shaders are living in both a raster and a raytraced flavor anyway, could this be done using SER? If we were to build a SBT with the different lighting and/or material shaders, dispatch a fake raygen shader that doesn't do any actual traces but rather use handcrafted HitObjects along with SER? Suddenly we let the driver/hardware worry about the sorting/tiling/compaction/... and give us coherent scheduling? Maybe (probably?) performance might be subpar? Exercise to the reader since I do not have the answer here (just wild ideas)!

Similar to this lighting/texturing idea, there are often multiple subtasks during rendering of a frame where we are sorting or binning in order to improve performance. With SER giving (or at least promising) us a solution for this, maybe we can be more creative in its use besides ray tracing? 
