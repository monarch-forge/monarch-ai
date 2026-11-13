use std::{fs, path::Path};

fn main() {
    // `bundle.resources` maps `resources/core/` → `core/`. tauri-build fails if that source
    // path is missing, which would break `cargo check` / `tauri dev` before the first
    // `npm run bundle:core`. Ensure it exists with a placeholder; scripts/bundle-core.mjs
    // wipes and repopulates the directory for release builds.
    let dir = Path::new("resources/core");
    if !dir.exists() {
        let _ = fs::create_dir_all(dir);
    }
    let empty = fs::read_dir(dir).map(|mut d| d.next().is_none()).unwrap_or(true);
    if empty {
        let _ = fs::write(
            dir.join("README.txt"),
            "Placeholder. Populated by `npm run bundle:core` (scripts/bundle-core.mjs).\n",
        );
    }
    println!("cargo:rerun-if-changed=resources/core");
    tauri_build::build()
}
