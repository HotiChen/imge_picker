#!/bin/bash
# setup-auth.sh — Apply client auth system to the imge_picker project
# Run this from the project root: bash setup-auth.sh
set -e

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
echo "Project dir: $PROJECT_DIR"

# ── 1. Replace worker.js with new version ─────────────────────────────────
if [ -f "$PROJECT_DIR/worker/worker.js.new" ]; then
  cp "$PROJECT_DIR/worker/worker.js.new" "$PROJECT_DIR/worker/worker.js"
  echo "✓ worker.js updated"
else
  echo "✗ worker.js.new not found"
fi

# ── 2. Update wrangler.toml with D1 binding ────────────────────────────────
WRANGLER="$PROJECT_DIR/worker/wrangler.toml"
if ! grep -q 'd1_databases' "$WRANGLER" 2>/dev/null; then
  cat >> "$WRANGLER" << 'TOML'

[[d1_databases]]
binding = "DB"
database_name = "imagepicker-db"
database_id = "1176e663-7f85-498a-b16d-a22ec9aaeacc"
TOML
  echo "✓ wrangler.toml updated with D1 binding"
else
  echo "✓ wrangler.toml already has d1_databases"
fi

# ── 3. Patch index.html ────────────────────────────────────────────────────
INDEX="$PROJECT_DIR/index.html"
if [ -f "$INDEX" ]; then
  # Remove old auth.js include if present (we'll replace with new script)
  # Add client-auth-check.js after config.js line
  if ! grep -q 'client-auth-check.js' "$INDEX"; then
    # Add after auth.js or after config.js
    if grep -q 'auth.js' "$INDEX"; then
      sed -i '' 's|<script src="js/auth.js"></script>|<script src="js/auth.js"></script>\n    <script src="js/client-auth-check.js"></script>|' "$INDEX"
    else
      # Add after the last config.js line
      sed -i '' 's|<script src="js/config.js[^"]*"></script>|&\n    <script src="js/client-auth-check.js"></script>|' "$INDEX"
    fi
    echo "✓ index.html patched with client-auth-check.js"
  else
    echo "✓ index.html already patched"
  fi
fi

# ── 4. Patch book_editor/index.html ────────────────────────────────────────
BOOK="$PROJECT_DIR/book_editor/index.html"
if [ -f "$BOOK" ]; then
  if ! grep -q 'can_book' "$BOOK"; then
    # Add permission check script before closing </head> or before first <script>
    sed -i '' 's|<script src="../js/config.js"></script>|<script src="../js/config.js"></script>\n    <script src="../js/book-auth-check.js"></script>|' "$BOOK"
    echo "✓ book_editor/index.html patched"
  else
    echo "✓ book_editor/index.html already patched"
  fi
fi

# ── 5. Patch upload.html ────────────────────────────────────────────────────
UPLOAD="$PROJECT_DIR/upload.html"
if [ -f "$UPLOAD" ]; then
  if ! grep -q 'can_upload' "$UPLOAD"; then
    sed -i '' 's|<script src="js/config.js"></script>|<script src="js/config.js"></script>\n<script src="js/upload-auth-check.js"></script>|' "$UPLOAD"
    echo "✓ upload.html patched"
  else
    echo "✓ upload.html already patched"
  fi
fi

# ── 6. Initialize D1 schema ─────────────────────────────────────────────────
echo ""
echo "Next step: initialize the D1 database schema."
echo "Run from the worker/ directory:"
echo "  cd worker && npx wrangler d1 execute imagepicker-db --remote --file=schema.sql"
echo ""
echo "Then deploy the updated worker:"
echo "  cd worker && npx wrangler deploy"
echo ""
echo "Done! Files written:"
echo "  - worker/worker.js.new  → now at worker/worker.js"
echo "  - worker/schema.sql     (D1 schema)"
echo "  - worker/wrangler.toml  (updated)"
echo "  - admin.html            (admin panel)"
echo "  - client-login.html     (client login/register)"
echo "  - js/client-auth-check.js"
echo "  - js/book-auth-check.js"
echo "  - js/upload-auth-check.js"
