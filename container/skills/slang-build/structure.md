# Slang Codebase Structure

```
slang/
├── source/slang/              # Core compiler (~800 files)
│   ├── slang-parser*.cpp      # Parser → AST
│   ├── slang-preprocessor.cpp # Preprocessor
│   ├── slang-ast-*.h/cpp      # AST node definitions
│   ├── slang-check-*.cpp      # Semantic analysis / type checking
│   ├── slang-lower-to-ir.cpp  # AST → IR lowering
│   ├── slang-ir*.h/cpp        # IR definitions and passes
│   ├── slang-emit-*.cpp       # Backend code generation
│   └── slang-compiler*.cpp    # Compiler driver
├── source/core/               # Core utilities (strings, containers)
├── source/compiler-core/      # Shared compiler infrastructure (lexer, diagnostics)
│   ├── slang-lexer*.cpp       # Lexer / tokenizer
├── tools/                     # CLI tools (slangc)
├── tests/                     # Test suite
│   ├── compute/               # Compute shader tests
│   ├── hlsl/                  # HLSL compatibility
│   ├── bugs/                  # Bug regressions
│   └── diagnostics/           # Error message tests
├── docs/                      # Documentation
├── prelude/                   # Stdlib prelude
└── CMakeLists.txt             # Build root
```

## Compiler Pipeline

```
Source → Lexer → Parser → AST → Semantic Check → IR → Passes → Backend Emit
```

1. **Lexer** (`source/compiler-core/slang-lexer.cpp`) → tokens
2. **Preprocessor** (`source/slang/slang-preprocessor.cpp`) → preprocessed tokens
3. **Parser** (`source/slang/slang-parser.cpp`) → AST nodes
3. **Semantic Check** (`slang-check*.cpp`) → validated, typed AST
4. **Lower to IR** (`slang-lower-to-ir.cpp`) → SSA-based IR
5. **IR Passes** (`slang-ir-*.cpp`) → optimized IR
6. **Backend Emit** (`slang-emit-*.cpp`) → target code

## Backend Targets

| File | Target |
|------|--------|
| `slang-emit-hlsl.cpp` | HLSL (DirectX) |
| `slang-emit-glsl.cpp` | GLSL (OpenGL/Vulkan) |
| `slang-emit-cuda.cpp` | CUDA |
| `slang-emit-spirv*.cpp` | SPIR-V (Vulkan/OpenCL) |
| `slang-emit-metal.cpp` | Metal (Apple) |
| `slang-emit-wgsl.cpp` | WGSL (WebGPU) |
| `slang-emit-c-like.cpp` | Base class for C-family targets |

## Tracing a Feature

To understand how a feature flows through the compiler:

1. **Syntax** — search parser for the keyword
2. **AST** — find the node type in `slang-ast-*.h`
3. **Checking** — find validation in `slang-check*.cpp`
4. **IR** — find lowering in `slang-lower*.cpp` and representation in `slang-ir*.h`
5. **Backend** — find emission in `slang-emit-*.cpp`
6. **Tests** — find coverage in `tests/`
