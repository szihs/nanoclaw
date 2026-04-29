# Backend Targets

Slang emits code for 8 target languages. All emitters inherit from a base class hierarchy.

## Emitter Hierarchy

```
SourceEmitterBase
└── CLikeSourceEmitter (slang-emit-c-like.cpp)
    ├── HLSLSourceEmitter (slang-emit-hlsl.cpp)
    ├── GLSLSourceEmitter (slang-emit-glsl.cpp)
    ├── CUDASourceEmitter (slang-emit-cuda.cpp)
    ├── MetalSourceEmitter (slang-emit-metal.cpp)
    ├── WGSLSourceEmitter (slang-emit-wgsl.cpp)
    └── CPPSourceEmitter (slang-emit-cpp.cpp)

SPIRVEmitterBase (slang-emit-spirv.cpp) — separate hierarchy, binary format
```

## Target Files

| File | Target | Format | Notes |
|------|--------|--------|-------|
| `slang-emit-hlsl.cpp` | HLSL | Text | DirectX shaders |
| `slang-emit-glsl.cpp` | GLSL | Text | OpenGL/Vulkan shaders |
| `slang-emit-cuda.cpp` | CUDA | Text | GPU compute |
| `slang-emit-spirv.cpp` | SPIR-V | Binary | Vulkan/OpenCL (separate emitter hierarchy) |
| `slang-emit-metal.cpp` | Metal | Text | Apple GPU shaders |
| `slang-emit-wgsl.cpp` | WGSL | Text | WebGPU shaders |
| `slang-emit-c-like.cpp` | — | — | Base class for all text-based targets |
| `slang-emit-cpp.cpp` | C/C++ | Text | Host-side code |

## Adding a New Backend

1. Create `slang-emit-<target>.cpp` inheriting from `CLikeSourceEmitter`
2. Override `emit*` virtual methods for target-specific constructs
3. Register the target in `slang-compiler.cpp`
4. Add legalization pass in `slang-ir-legalize.cpp` if needed
5. Add tests in `tests/<target>/`

## SPIR-V Special Cases

SPIR-V is binary, not text — it has a completely separate emitter that builds SPIR-V instructions directly rather than generating source code. Key files:
- `slang-emit-spirv.cpp` — main emitter
- `slang-emit-spirv-ops.cpp` — SPIR-V opcode helpers
- `spirv/unified1/spirv.h` — SPIR-V spec headers

## Legalization

Before emission, IR passes "legalize" code for specific targets:
- `slang-ir-legalize-types.cpp` — type layout adjustments
- `slang-ir-legalize-global-values.cpp` — global variable handling
- Target-specific passes invoked by the emit pipeline
