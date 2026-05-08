#!/usr/bin/env bash
#
# Build a drop-in WordPress plugin zip with production dependencies bundled.
#
# Output: dist/wp-headless-kit-<version>.zip
#
# Usage (from anywhere):
#   ./bin/build-release.sh
#
# The resulting zip is what you upload via WP Admin → Plugins → Add New →
# Upload Plugin. No composer required on the target site.

set -euo pipefail

PLUGIN_SLUG="wp-headless-kit"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
BUILD_DIR="${PLUGIN_ROOT}/build"
DIST_DIR="${PLUGIN_ROOT}/dist"
STAGE_DIR="${BUILD_DIR}/${PLUGIN_SLUG}"

# --- Tool checks ---------------------------------------------------------

require_tool() {
    if ! command -v "$1" >/dev/null 2>&1; then
        echo "ERROR: required tool '$1' is not on PATH." >&2
        echo "       Install it and re-run this script." >&2
        exit 1
    fi
}

require_tool composer

# `zip` isn't a hard requirement — on Windows we fall back to PowerShell's
# Compress-Archive, which ships with the OS. Picking the strategy upfront
# fails fast with a clear message if neither is available.
ZIP_STRATEGY=""
if command -v zip >/dev/null 2>&1; then
    ZIP_STRATEGY="zip"
elif command -v powershell.exe >/dev/null 2>&1; then
    ZIP_STRATEGY="powershell"
elif command -v pwsh >/dev/null 2>&1; then
    ZIP_STRATEGY="pwsh"
else
    echo "ERROR: no archiver found on PATH (need 'zip', 'powershell.exe', or 'pwsh')." >&2
    echo "       On Linux/macOS install zip via your package manager." >&2
    echo "       On Windows, PowerShell ships with the OS — check that 'powershell.exe' is on PATH." >&2
    exit 1
fi

# --- Read version from plugin header ------------------------------------

PLUGIN_FILE="${PLUGIN_ROOT}/${PLUGIN_SLUG}.php"
if [[ ! -f "${PLUGIN_FILE}" ]]; then
    echo "ERROR: plugin file not found at ${PLUGIN_FILE}" >&2
    exit 1
fi

VERSION="$(
    grep -E '^[[:space:]]*\*[[:space:]]*Version:' "${PLUGIN_FILE}" \
        | head -n 1 \
        | sed -E 's/.*Version:[[:space:]]*([0-9A-Za-z.+\-]+).*/\1/'
)"
if [[ -z "${VERSION}" ]]; then
    echo "ERROR: could not parse 'Version:' header from ${PLUGIN_FILE}" >&2
    exit 1
fi

ZIP_NAME="${PLUGIN_SLUG}-${VERSION}.zip"
ZIP_PATH="${DIST_DIR}/${ZIP_NAME}"

# --- Clean staging -------------------------------------------------------

echo "→ Building ${ZIP_NAME}"
echo "  plugin root: ${PLUGIN_ROOT}"

rm -rf "${BUILD_DIR}"
mkdir -p "${STAGE_DIR}" "${DIST_DIR}"

# --- Copy production source into stage ----------------------------------

# Explicit copy keeps the script dependency-free (no rsync required).
# Add new top-level production files here as the plugin grows.
cp "${PLUGIN_FILE}"                         "${STAGE_DIR}/"
cp "${PLUGIN_ROOT}/composer.json"           "${STAGE_DIR}/"
cp "${PLUGIN_ROOT}/README.md"               "${STAGE_DIR}/"
cp -R "${PLUGIN_ROOT}/includes"             "${STAGE_DIR}/"

# --- Install production-only dependencies in the stage ------------------

echo "→ composer install --no-dev --optimize-autoloader"
(
    cd "${STAGE_DIR}"
    composer install \
        --no-dev \
        --optimize-autoloader \
        --no-progress \
        --no-interaction \
        --quiet
)

# Sanity check: Jetpack Autoloader output must exist or the plugin will
# fail loudly at runtime — we want to fail loudly at build time instead.
if [[ ! -f "${STAGE_DIR}/vendor/autoload_packages.php" ]]; then
    echo "ERROR: vendor/autoload_packages.php missing after composer install." >&2
    echo "       Confirm 'automattic/jetpack-autoloader' is in composer.json require." >&2
    exit 1
fi

# --- Zip -----------------------------------------------------------------

echo "→ Zipping → ${ZIP_PATH}"
rm -f "${ZIP_PATH}"

case "${ZIP_STRATEGY}" in
    zip)
        (
            cd "${BUILD_DIR}"
            zip -rq "${ZIP_PATH}" "${PLUGIN_SLUG}"
        )
        ;;
    powershell|pwsh)
        # Compress-Archive needs Windows-style paths. Convert via cygpath
        # when available (Git Bash / MSYS), fall back to forward-slash
        # paths otherwise — modern PowerShell handles both.
        if command -v cygpath >/dev/null 2>&1; then
            WIN_SOURCE="$(cygpath -w "${BUILD_DIR}/${PLUGIN_SLUG}")"
            WIN_DEST="$(cygpath -w "${ZIP_PATH}")"
        else
            WIN_SOURCE="${BUILD_DIR}/${PLUGIN_SLUG}"
            WIN_DEST="${ZIP_PATH}"
        fi
        PS_CMD="${ZIP_STRATEGY}"
        if [ "${ZIP_STRATEGY}" = "powershell" ]; then
            PS_CMD="powershell.exe"
        fi
        "${PS_CMD}" -NoProfile -ExecutionPolicy Bypass -Command \
            "Compress-Archive -Path '${WIN_SOURCE}' -DestinationPath '${WIN_DEST}' -Force"
        ;;
esac

# --- Cleanup -------------------------------------------------------------

rm -rf "${BUILD_DIR}"

ZIP_SIZE="$(du -h "${ZIP_PATH}" | awk '{print $1}')"
echo ""
echo "✓ Built ${ZIP_NAME} (${ZIP_SIZE})"
echo "  ${ZIP_PATH}"
echo ""
echo "Drop-in: WP Admin → Plugins → Add New → Upload Plugin → select the zip → Install → Activate."
