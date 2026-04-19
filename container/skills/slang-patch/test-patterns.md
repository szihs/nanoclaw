# Slang Test Patterns

## Test File Format

All `.slang` test files use `//TEST` directives in comments:

```slang
//TEST(compute):COMPARE_COMPUTE_EX:-slang -compute -shaderobj
//TEST_INPUT:ubuffer(data=[1 2 3 4], stride=4):name=input

[numthreads(1,1,1)]
void computeMain(uint3 tid: SV_DispatchThreadID)
{
    outputBuffer[tid.x] = inputBuffer[tid.x] * 2;
}
```

## Common Directive Patterns

| Pattern | Use For |
|---------|---------|
| `//TEST(compute):COMPARE_COMPUTE_EX:...` | Compute shader tests with expected output |
| `//TEST:SIMPLE(filecheck=CHECK): -target spirv` | SPIR-V output validation with FileCheck |
| `//TEST:SIMPLE: -target hlsl` | HLSL code generation check |
| `//TEST_INPUT:ubuffer(data=[...]):name=input` | Input buffer declaration |
| `//TEST:DIAGNOSTIC:` | Error/warning message validation |

## FileCheck Tests

```slang
//TEST:SIMPLE(filecheck=CHECK): -target spirv
// CHECK: OpEntryPoint

[shader("compute")]
[numthreads(1,1,1)]
void main() {}
```

## Diagnostic Tests

```slang
//TEST:DIAGNOSTIC:
void test() {
    // CHECK-DIAGNOSTIC: error 30001
    int x = "not an int";
}
```

## Where to Put Tests

| Directory | Purpose |
|-----------|---------|
| `tests/bugs/issue-<N>.slang` | Bug regressions (reference issue number) |
| `tests/compute/` | Compute shader functionality |
| `tests/hlsl/` | HLSL compatibility |
| `tests/diagnostics/` | Error message validation |
| `tests/language-feature/` | Language feature coverage |

## Running Tests

```bash
# Single test
./build/Debug/bin/slang-test tests/bugs/issue-5000.slang

# Category
./build/Debug/bin/slang-test tests/compute/

# With test server (CPU-only, no GPU)
./build/Debug/bin/slang-test -use-test-server tests/compute/
```
