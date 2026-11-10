import { release } from 'node:os';
import { nativeTheme } from 'electron/main';
import type { BrowserWindow } from 'electron/main';

const windowsBuild = process.platform === 'win32' ? Number(release().split('.')[2]) : 0;
/** Bind the compositor once so a native drag can suspend blur without loading anything. */
export async function createGlassSwitch(win: BrowserWindow): Promise<((enabled: boolean) => void) | undefined> {
  if (windowsBuild < 17134 || nativeTheme.prefersReducedTransparency
    || nativeTheme.shouldUseHighContrastColors) return;
  if (windowsBuild >= 22621) {
    return (enabled) => win.setBackgroundMaterial(enabled ? 'acrylic' : 'none');
  }
  try {
    const { default: ffi } = await import('koffi');
    const policy = ffi.struct({ state: 'int', flags: 'int', tint: 'uint32_t', animation: 'int' });
    const attribute = ffi.struct({ id: 'int', data: ffi.pointer(policy), size: 'size_t' });
    const apply = ffi.load('user32.dll').func('__stdcall', 'SetWindowCompositionAttribute', 'int',
      ['uintptr_t', ffi.pointer(attribute)]);
    const handle = win.getNativeWindowHandle();
    const hwnd = handle.length === 8 ? handle.readBigUInt64LE() : handle.readUInt32LE();
    return (enabled) => {
      const applied = apply(hwnd, {
        id: 19, // WCA_ACCENT_POLICY: state 4 enables acrylic, state 0 disables it.
        data: { state: enabled ? 4 : 0, flags: enabled ? 2 : 0, tint: enabled ? 0x20547751 : 0, animation: 0 },
        size: ffi.sizeof(policy),
      });
      if (!applied) console.warn('Windows 未能切换毛玻璃效果。');
    };
  } catch (error) {
    // The translucent renderer remains usable on systems without the legacy compositor.
    console.warn('系统毛玻璃未启用，使用半透明绿色面板。', error);
  }
}
