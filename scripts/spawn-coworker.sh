#!/usr/bin/env bash
#
# spawn-coworker.sh — Spawn a new Slang coworker instance
#
# Usage:
#   ./scripts/spawn-coworker.sh [--type <coworker-type>] <name> [task]
#
# Examples:
#   ./scripts/spawn-coworker.sh --type slang-ir "ir-generics" "Investigate generics lowering in IR"
#   ./scripts/spawn-coworker.sh --type slang-cuda "cuda-atomics" "Add atomic operation support"
#   ./scripts/spawn-coworker.sh "general-explorer" "Explore the Slang repo structure"
#
# The script:
#   1. Creates a group folder from the coworker type template
#   2. Sets up a git worktree for the Slang repo
#   3. Registers the group in the NanoClaw database
#   4. Optionally sends the initial task prompt via IPC

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
GROUPS_DIR="$PROJECT_DIR/groups"
DATA_DIR="$PROJECT_DIR/data"
STORE_DIR="$PROJECT_DIR/store"
COWORKER_TYPES="$GROUPS_DIR/coworker-types.json"

# Defaults
COWORKER_TYPE="slang-base"

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --type)
            COWORKER_TYPE="$2"
            shift 2
            ;;
        --list|-l)
            echo "=== Coworker Types ==="
            if command -v jq &>/dev/null && [[ -f "$COWORKER_TYPES" ]]; then
                jq -r 'to_entries[] | "  \(.key): \(.value.description)"' "$COWORKER_TYPES"
            else
                echo "  (install jq to see types, or check groups/coworker-types.json)"
            fi
            echo ""
            echo "=== Active Instances ==="
            for dir in "$GROUPS_DIR"/slang_*/; do
                [[ -d "$dir" ]] || continue
                name=$(basename "$dir")
                echo "  $name"
            done
            if ! ls "$GROUPS_DIR"/slang_*/ &>/dev/null 2>&1; then
                echo "  (none)"
            fi
            exit 0
            ;;
        --help|-h)
            echo "Usage: $0 [--type <coworker-type>] [--list] <name> [task]"
            echo ""
            echo "Options:"
            echo "  --type <type>  Coworker type (default: slang-base)"
            echo "  --list         List all types and active instances"
            echo "  --help         Show this help"
            echo ""
            echo "Available coworker types:"
            if command -v jq &>/dev/null && [[ -f "$COWORKER_TYPES" ]]; then
                jq -r 'to_entries[] | "  \(.key): \(.value.description)"' "$COWORKER_TYPES"
            else
                echo "  (install jq to see types, or check groups/coworker-types.json)"
            fi
            exit 0
            ;;
        *)
            break
            ;;
    esac
done

if [[ $# -lt 1 ]]; then
    echo "Error: coworker name is required"
    echo "Usage: $0 [--type <coworker-type>] <name> [task]"
    exit 1
fi

COWORKER_NAME="$1"
TASK="${2:-}"

# Validate coworker name (alphanumeric + hyphens only)
if [[ ! "$COWORKER_NAME" =~ ^[a-zA-Z0-9_-]+$ ]]; then
    echo "Error: coworker name must be alphanumeric with hyphens/underscores only"
    exit 1
fi

FOLDER_NAME="slang_${COWORKER_NAME}"
GROUP_DIR="$GROUPS_DIR/$FOLDER_NAME"

# Check if group already exists
if [[ -d "$GROUP_DIR" ]]; then
    echo "Error: group folder already exists: $GROUP_DIR"
    echo "To reuse this coworker, send it a new task via the channel."
    exit 1
fi

echo "==> Spawning coworker: $COWORKER_NAME (type: $COWORKER_TYPE)"

# --- Step 1: Create group folder from template ---
echo "  Creating group folder: $FOLDER_NAME"
mkdir -p "$GROUP_DIR"

# Get base template
BASE_TYPE="slang-base"
if command -v jq &>/dev/null && [[ -f "$COWORKER_TYPES" ]]; then
    BASE_TYPE=$(jq -r --arg t "$COWORKER_TYPE" '.[$t].base // "slang-base"' "$COWORKER_TYPES")
fi

# Copy base CLAUDE.md
BASE_DIR="$GROUPS_DIR/$BASE_TYPE"
if [[ -f "$BASE_DIR/CLAUDE.md" ]]; then
    cp "$BASE_DIR/CLAUDE.md" "$GROUP_DIR/CLAUDE.md"
    echo "  Copied base template from $BASE_TYPE"
fi

# Append domain-specific template if different from base
DOMAIN_DIR="$GROUPS_DIR/$COWORKER_TYPE"
if [[ "$COWORKER_TYPE" != "$BASE_TYPE" && -f "$DOMAIN_DIR/CLAUDE.md" ]]; then
    echo "" >> "$GROUP_DIR/CLAUDE.md"
    echo "---" >> "$GROUP_DIR/CLAUDE.md"
    echo "" >> "$GROUP_DIR/CLAUDE.md"
    cat "$DOMAIN_DIR/CLAUDE.md" >> "$GROUP_DIR/CLAUDE.md"
    echo "  Appended domain template from $COWORKER_TYPE"
fi

# Create workspace directories
mkdir -p "$GROUP_DIR/investigations"
mkdir -p "$GROUP_DIR/architecture"

# --- Step 2: Set up git worktree ---
SLANG_REPO="$DATA_DIR/slang-repo"
WORKTREE_DIR="$DATA_DIR/worktrees/$COWORKER_NAME"

if [[ -d "$SLANG_REPO/.git" ]]; then
    echo "  Creating git worktree: $WORKTREE_DIR"
    cd "$SLANG_REPO"
    git worktree add "$WORKTREE_DIR" -b "coworker/$COWORKER_NAME" 2>/dev/null || {
        echo "  Warning: could not create worktree (branch may exist). Using detached HEAD."
        git worktree add --detach "$WORKTREE_DIR" 2>/dev/null || true
    }
elif [[ ! -d "$SLANG_REPO" ]]; then
    echo "  Slang repo not found at $SLANG_REPO"
    echo "  To set up: git clone https://github.com/shader-slang/slang.git $SLANG_REPO"
    echo "  Coworker will clone on first use instead."
fi

# --- Step 3: Register group via IPC ---
# Use a synthetic JID for CLI-spawned coworkers
JID="cli:slang-${COWORKER_NAME}"
IPC_DIR="$DATA_DIR/ipc/main/tasks"
mkdir -p "$IPC_DIR"

TIMESTAMP=$(date +%s%N)
CONTAINER_CONFIG="{}"

# Build container config with additional mount for worktree
if [[ -d "$WORKTREE_DIR" ]]; then
    CONTAINER_CONFIG=$(cat <<CEOF
{
  "additionalMounts": [
    {
      "hostPath": "$WORKTREE_DIR",
      "containerPath": "slang",
      "readonly": false
    }
  ]
}
CEOF
)
fi

cat > "$IPC_DIR/register_${TIMESTAMP}.json" <<EOF
{
  "type": "register_group",
  "jid": "$JID",
  "name": "Slang: $COWORKER_NAME",
  "folder": "$FOLDER_NAME",
  "trigger": "@slang",
  "requiresTrigger": false,
  "containerConfig": $CONTAINER_CONFIG
}
EOF

echo "  Registered group: $JID → $FOLDER_NAME"

# --- Step 4: Send initial task (if provided) ---
if [[ -n "$TASK" ]]; then
    INPUT_DIR="$DATA_DIR/ipc/$FOLDER_NAME/input"
    mkdir -p "$INPUT_DIR"
    if command -v jq &>/dev/null; then
        jq -n --arg text "$TASK" '{"type":"message","text":$text}' > "$INPUT_DIR/task_${TIMESTAMP}.json"
    else
        ESCAPED_TASK="${TASK//\\/\\\\}"
        ESCAPED_TASK="${ESCAPED_TASK//\"/\\\"}"
        cat > "$INPUT_DIR/task_${TIMESTAMP}.json" <<EOF
{"type":"message","text":"$ESCAPED_TASK"}
EOF
    fi
    echo "  Queued initial task: $TASK"
fi

echo ""
echo "==> Coworker '$COWORKER_NAME' ready!"
echo "    Type:   $COWORKER_TYPE"
echo "    Folder: $GROUP_DIR"
echo "    JID:    $JID"
if [[ -d "$WORKTREE_DIR" ]]; then
    echo "    Worktree: $WORKTREE_DIR"
fi
if [[ -n "$TASK" ]]; then
    echo "    Task:   $TASK"
fi
