# Sourced by scripts/{build,deploy}.sh.
# If nvm is present AND .nvmrc exists, switch to the pinned Node version so
# ares-cli runs on a supported version (Node 22+ breaks it: isDate removed).
# Silent no-op if nvm isn't installed.
if [ -s "$HOME/.nvm/nvm.sh" ]; then
    # shellcheck disable=SC1091
    . "$HOME/.nvm/nvm.sh" >/dev/null
    if [ -f .nvmrc ]; then
        nvm use --silent >/dev/null 2>&1 || nvm use >/dev/null
    fi
fi
