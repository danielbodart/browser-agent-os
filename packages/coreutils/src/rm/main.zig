const std = @import("std");

extern "wasi_snapshot_preview1" fn path_unlink_file(
    dirfd: i32,
    path_ptr: [*]const u8,
    path_len: u32,
) u32;

extern "wasi_snapshot_preview1" fn path_remove_directory(
    dirfd: i32,
    path_ptr: [*]const u8,
    path_len: u32,
) u32;

extern "wasi_snapshot_preview1" fn path_open(
    dirfd: i32,
    dirflags: u32,
    path_ptr: [*]const u8,
    path_len: u32,
    oflags: u32,
    fs_rights_base: u64,
    fs_rights_inheriting: u64,
    fdflags: u32,
    fd_out: *i32,
) u32;

extern "wasi_snapshot_preview1" fn fd_close(fd: i32) u32;

extern "wasi_snapshot_preview1" fn fd_readdir(
    fd: i32,
    buf_ptr: [*]u8,
    buf_len: u32,
    cookie: u64,
    size_out: *u32,
) u32;

const Dirent = extern struct {
    d_next: u64,
    d_ino: u64,
    d_namlen: u32,
    d_type: u8,
    _padding: [3]u8,
};

const PREOPEN_FD: i32 = 3;
const OFLAG_DIRECTORY: u32 = 0x2;
const FILETYPE_DIRECTORY: u8 = 3;
const ERRNO_NOENT: u32 = 44;
const ERRNO_ISDIR: u32 = 31;

const Allocator = std.mem.Allocator;

pub fn main(init: std.process.Init) !void {
    const allocator = std.heap.wasm_allocator;
    var iter = try init.minimal.args.iterateAllocator(allocator);
    defer iter.deinit();

    var ebuf: [256]u8 = undefined;
    var err = std.Io.File.stderr().writer(init.io, &ebuf);

    _ = iter.next();

    var recursive = false;
    var force = false;
    var any = false;
    var saw_error = false;

    while (iter.next()) |arg| {
        if (arg.len > 1 and arg[0] == '-' and !std.mem.eql(u8, arg, "-")) {
            for (arg[1..]) |c| switch (c) {
                'r', 'R' => recursive = true,
                'f' => force = true,
                else => {
                    err.interface.print("rm: invalid option -- '{c}'\n", .{c}) catch {};
                    err.interface.flush() catch {};
                    std.process.exit(1);
                },
            };
            continue;
        }
        any = true;
        if (removePath(allocator, arg, recursive)) |_| {} else |e| {
            if (force and e == error.NotFound) continue;
            saw_error = true;
            err.interface.print("rm: {s}: {s}\n", .{arg, @errorName(e)}) catch {};
            err.interface.flush() catch {};
        }
    }

    if (!any and !force) {
        err.interface.writeAll("rm: missing operand\n") catch {};
        err.interface.flush() catch {};
        std.process.exit(1);
    }
    if (saw_error) std.process.exit(1);
}

fn removePath(allocator: Allocator, path: []const u8, recursive: bool) !void {
    const ue = path_unlink_file(PREOPEN_FD, path.ptr, @intCast(path.len));
    if (ue == 0) return;
    if (ue == ERRNO_NOENT) return error.NotFound;
    if (ue != ERRNO_ISDIR) return error.UnlinkFailed;
    if (!recursive) return error.IsDirectory;
    try removeTree(allocator, path);
}

fn removeTree(allocator: Allocator, root: []const u8) !void {
    var stack: std.ArrayList([]u8) = .empty;
    defer {
        for (stack.items) |s| allocator.free(s);
        stack.deinit(allocator);
    }
    var post_dirs: std.ArrayList([]u8) = .empty;
    defer {
        for (post_dirs.items) |s| allocator.free(s);
        post_dirs.deinit(allocator);
    }

    try stack.append(allocator, try allocator.dupe(u8, root));

    while (stack.pop()) |current| {
        try post_dirs.append(allocator, current);

        var dirfd: i32 = -1;
        if (path_open(PREOPEN_FD, 0, current.ptr, @intCast(current.len), OFLAG_DIRECTORY, 0, 0, 0, &dirfd) != 0) {
            return error.OpenFailed;
        }
        defer _ = fd_close(dirfd);

        var buf: [4096]u8 = undefined;
        var cookie: u64 = 0;
        while (true) {
            var size: u32 = 0;
            if (fd_readdir(dirfd, &buf, buf.len, cookie, &size) != 0) return error.ReaddirFailed;
            if (size == 0) break;
            var i: usize = 0;
            var advanced = false;
            while (i + @sizeOf(Dirent) <= size) {
                const ent: *const Dirent = @ptrCast(@alignCast(&buf[i]));
                const name_start = i + @sizeOf(Dirent);
                const name_end = name_start + ent.d_namlen;
                if (name_end > size) break;
                const child = try joinPath(allocator, current, buf[name_start..name_end]);
                if (ent.d_type == FILETYPE_DIRECTORY) {
                    try stack.append(allocator, child);
                } else {
                    defer allocator.free(child);
                    if (path_unlink_file(PREOPEN_FD, child.ptr, @intCast(child.len)) != 0) {
                        return error.UnlinkFailed;
                    }
                }
                cookie = ent.d_next;
                i = name_end;
                advanced = true;
            }
            if (!advanced) break;
        }
    }

    var idx: usize = post_dirs.items.len;
    while (idx > 0) {
        idx -= 1;
        const p = post_dirs.items[idx];
        if (path_remove_directory(PREOPEN_FD, p.ptr, @intCast(p.len)) != 0) return error.RmdirFailed;
    }
}

fn joinPath(allocator: Allocator, dir: []const u8, name: []const u8) ![]u8 {
    const needs_sep = dir.len > 0 and dir[dir.len - 1] != '/';
    const total = dir.len + (if (needs_sep) @as(usize, 1) else 0) + name.len;
    var out = try allocator.alloc(u8, total);
    @memcpy(out[0..dir.len], dir);
    var off: usize = dir.len;
    if (needs_sep) {
        out[off] = '/';
        off += 1;
    }
    @memcpy(out[off .. off + name.len], name);
    return out;
}
