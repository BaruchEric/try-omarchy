use std::mem;
use std::slice;
use std::str;
use std::sync::Mutex;

static OUTPUT: Mutex<Vec<u8>> = Mutex::new(Vec::new());

const HELP: &[&str] = &[
    "Browser Edition commands:",
    "  fastfetch  ls  pwd  cat README.md  whoami  uname -a",
    "  omarchy-version  omarchy-menu  omarchy-theme-set <theme>",
    "  open <terminal|files|editor|browser|themes|keybindings>",
];

fn is_theme(value: &str) -> bool {
    matches!(
        value,
        "catppuccin" | "gruvbox" | "matte-black" | "rose-pine" | "tokyo-night" | "white"
    )
}

fn is_app(value: &str) -> bool {
    matches!(
        value,
        "terminal" | "files" | "editor" | "browser" | "themes" | "keybindings" | "about"
    )
}

fn title_theme(value: &str) -> String {
    value
        .split('-')
        .map(|part| {
            let mut chars = part.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn execute(command: &str, theme: &str) -> (String, Vec<String>) {
    let input = command.trim();
    if input.is_empty() {
        return (String::new(), Vec::new());
    }
    let parts = input.split_whitespace().collect::<Vec<_>>();
    let program = parts[0];
    match program {
        "clear" => ("clear".into(), Vec::new()),
        "help" => (String::new(), HELP.iter().map(|line| (*line).into()).collect()),
        "fastfetch" => (
            String::new(),
            vec![
                "       /\\         omarchy@browser".into(),
                "      /  \\        ----------------".into(),
                "     / /\\ \\       OS: Omarchy Quattro Browser Edition".into(),
                "    / ____ \\      Shell: Quattro Wasm userspace".into(),
                format!("   /_/    \\_\\     Theme: {}", title_theme(theme)),
                "                  Runtime: Rust/Wasm + browser-native compositor".into(),
            ],
        ),
        "ls" => (
            String::new(),
            vec!["Desktop  Documents  Downloads  Projects  README.md".into()],
        ),
        "pwd" => (String::new(), vec!["/home/omarchy".into()]),
        "whoami" => (String::new(), vec!["omarchy".into()]),
        "uname" => (
            String::new(),
            vec!["Omarchy-Browser wasm 4.0.0-alpha #1 client-side browser".into()],
        ),
        "omarchy-version" => (String::new(), vec!["4.0.0.alpha-browser.1".into()]),
        "cat" if parts.get(1) == Some(&"README.md") => (
            String::new(),
            vec![
                "# Omarchy Quattro Browser Edition".into(),
                "A performance-first client-side distribution derived from official Quattro.".into(),
                "Press Super+Space to explore the authentic Omarchy menu workflow.".into(),
            ],
        ),
        "omarchy-menu" => ("menu".into(), Vec::new()),
        "open" if parts.get(1).is_some_and(|app| is_app(app)) => {
            (format!("open:{}", parts[1]), Vec::new())
        }
        "omarchy-theme-set" if parts.get(1).is_some_and(|theme| is_theme(theme)) => (
            format!("theme:{}", parts[1]),
            vec![format!("Theme changed to {}", title_theme(parts[1]))],
        ),
        "omarchy-theme-set" => (
            String::new(),
            vec![format!("Unknown theme: {}", parts.get(1).copied().unwrap_or(""))],
        ),
        _ => (
            String::new(),
            vec![format!(
                "bash: {program}: command not available in Browser Edition"
            )],
        ),
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn omarchy_userspace_abi() -> u32 {
    1
}

#[unsafe(no_mangle)]
pub extern "C" fn omarchy_userspace_alloc(length: u32) -> u32 {
    let mut bytes = Vec::<u8>::with_capacity(length as usize);
    let pointer = bytes.as_mut_ptr() as u32;
    mem::forget(bytes);
    pointer
}

#[unsafe(no_mangle)]
pub extern "C" fn omarchy_userspace_exec(pointer: u32, length: u32, theme_pointer: u32, theme_length: u32) -> u64 {
    let command = unsafe { slice::from_raw_parts(pointer as *const u8, length as usize) };
    let theme = unsafe { slice::from_raw_parts(theme_pointer as *const u8, theme_length as usize) };
    let command = str::from_utf8(command).unwrap_or("").to_owned();
    let theme = str::from_utf8(theme).unwrap_or("tokyo-night").to_owned();
    unsafe {
        drop(Vec::from_raw_parts(pointer as *mut u8, 0, length as usize));
        drop(Vec::from_raw_parts(theme_pointer as *mut u8, 0, theme_length as usize));
    }

    let (effect, lines) = execute(&command, &theme);
    let mut output = OUTPUT.lock().expect("userspace output lock poisoned");
    output.clear();
    output.extend_from_slice(effect.as_bytes());
    output.push(0);
    output.extend_from_slice(lines.join("\n").as_bytes());
    let output_pointer = output.as_ptr() as u32;
    ((output_pointer as u64) << 32) | output.len() as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exposes_quattro_identity_and_theme() {
        let (_, output) = execute("fastfetch", "rose-pine");
        let rendered = output.join("\n");
        assert!(rendered.contains("Omarchy Quattro Browser Edition"));
        assert!(rendered.contains("Quattro Wasm userspace"));
        assert!(rendered.contains("Theme: Rose Pine"));
    }

    #[test]
    fn emits_only_allowlisted_browser_effects() {
        assert_eq!(execute("omarchy-menu", "tokyo-night").0, "menu");
        assert_eq!(execute("open files", "tokyo-night").0, "open:files");
        assert_eq!(
            execute("omarchy-theme-set gruvbox", "tokyo-night").0,
            "theme:gruvbox"
        );
        assert_eq!(execute("open shellcode", "tokyo-night").0, "");
    }
}
