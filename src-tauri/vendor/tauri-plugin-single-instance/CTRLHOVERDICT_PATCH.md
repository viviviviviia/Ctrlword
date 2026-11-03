# Local compatibility patch

Source: tauri-apps/plugins-workspace, v1 commit
`fa8ee1d4f2115bf1201cb4b4082d343476c01785`.
The directory was copied from the exact checkout used by Pot's lockfile.
Original MIT / Apache-2.0 license files are retained.

Changes:

- Resolve workspace package/dependency inheritance for this standalone vendor crate.
- In the Windows window procedure, access the callback only for WM_COPYDATA and
  only after checking GWL_USERDATA. Window creation messages arrive before it is set.
- Clear GWL_USERDATA when freeing the callback to avoid dereferencing freed state.

Without this change the original plugin aborted on startup with Rust 1.99.1:
`null reference produced` at platform_impl/windows.rs:116.
No instance detection or callback behavior was removed.
