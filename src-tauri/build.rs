fn main() {
    // tauri-build 只在 tauri.conf.json 等少数输入变化时重跑，单独替换图标不会重新
    // 编译 Windows 资源，exe 里会继续嵌旧图标。显式声明依赖，换个图标也能生效。
    println!("cargo:rerun-if-changed=icons");
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=icons/32x32.png");
    println!("cargo:rerun-if-changed=icons/128x128.png");
    println!("cargo:rerun-if-changed=icons/128x128@2x.png");
    tauri_build::build()
}
