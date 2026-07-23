import { FsError } from "./errors";
import { MAX_COMPONENT_BYTES, MAX_PATH_BYTES, MAX_PATH_DEPTH } from "./limits";

function utf8Length(value: string, label: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x7f) {
      bytes += 1;
    } else if (codeUnit <= 0x7ff) {
      bytes += 2;
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) {
        throw new FsError("EINVAL", `${label} is not canonically representable as UTF-8`);
      }
      bytes += 4;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new FsError("EINVAL", `${label} is not canonically representable as UTF-8`);
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

export function encodedUtf8Length(value: string): number {
  return utf8Length(value, "string");
}

export function validatePathComponent(component: string): number {
  if (component.length === 0 || component === "." || component === "..") {
    throw new FsError("EINVAL", "path contains an empty or reserved component");
  }
  if (component.includes("/") || component.includes("\0")) {
    throw new FsError("EINVAL", "path component contains a forbidden character");
  }
  const bytes = utf8Length(component, "path component");
  if (bytes > MAX_COMPONENT_BYTES) {
    throw new FsError("EINVAL", `path component exceeds ${MAX_COMPONENT_BYTES} UTF-8 bytes`);
  }
  return bytes;
}

export function parsePath(path: string): string[] {
  if (path === "/") {
    return [];
  }
  if (!path.startsWith("/") || path.endsWith("/") || path.includes("//")) {
    throw new FsError("EINVAL", "path must be absolute and canonical", { path });
  }
  if (utf8Length(path, "path") > MAX_PATH_BYTES) {
    throw new FsError("EINVAL", `path exceeds ${MAX_PATH_BYTES} UTF-8 bytes`, { path });
  }
  const components = path.slice(1).split("/");
  if (components.length > MAX_PATH_DEPTH) {
    throw new FsError("EINVAL", `path exceeds ${MAX_PATH_DEPTH} components`, { path });
  }
  for (const component of components) {
    validatePathComponent(component);
  }
  return components;
}
