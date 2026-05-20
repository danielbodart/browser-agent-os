const std = @import("std");

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

extern "wasi_snapshot_preview1" fn path_create_directory(
    dirfd: i32,
    path_ptr: [*]const u8,
    path_len: u32,
) u32;

const Iovec = extern struct { buf: [*]u8, buf_len: u32 };
const ConstIovec = extern struct { buf: [*]const u8, buf_len: u32 };

extern "wasi_snapshot_preview1" fn fd_read(
    fd: i32,
    iovs_ptr: [*]const Iovec,
    iovs_len: u32,
    nread_out: *u32,
) u32;

extern "wasi_snapshot_preview1" fn fd_write(
    fd: i32,
    iovs_ptr: [*]const ConstIovec,
    iovs_len: u32,
    nwritten_out: *u32,
) u32;

const Dirent = extern struct {
    d_next: u64,
    d_ino: u64,
    d_namlen: u32,
    d_type: u8,
    _padding: [3]u8,
};

const PREOPEN_FD: i32 = 3;
const OFLAG_CREAT: u32 = 0x1;
const OFLAG_DIRECTORY: u32 = 0x2;
const OFLAG_TRUNC: u32 = 0x8;
const FILETYPE_DIRECTORY: u8 = 3;
const ERRNO_NOENT: u32 = 44;
const ERRNO_ISDIR: u32 = 31;
const ERRNO_EXIST: u32 = 20;

const Allocator = std.mem.Allocator;

pub fn main(init: std.process.Init) !void {
    const allocator = std.heap.wasm_allocator;
    var iter = try init.minimal.args.iterateAllocator(allocator);
    defer iter.deinit();

    var ebuf: [256]u8 = undefined;
    var err = std.Io.File.stderr().writer(init.io, &ebuf);

    _ = iter.next();

    var recursive = false;
    var positionals: std.ArrayList([]const u8) = .empty;
    defer positionals.deinit(allocator);

    while (iter.next()) |arg| {
        if (arg.len > 1 and arg[0] == '-' and !std.mem.eql(u8, arg, "-")) {
            for (arg[1..]) |c| switch (c) {
                'r', 'R' => recursive = true,
                else => {
                    err.interface.print("cp: invalid option -- '{c}'\n", .{c}) catch {};
                    err.interface.flush() catch {};
                    std.process.exit(1);
                },
            };
            continue;
        }
        try positionals.append(allocator, arg);
    }

    if (positionals.items.len < 2) {
        err.interface.writeAll("cp: missing operand\n") catch {};
        err.interface.flush() catch {};
        std.process.exit(1);
    }

    const src = positionals.items[0];
    const dest = positionals.items[1];

    if (doCopy(allocator, src, dest, recursive)) |_| {} else |e| {
        const msg = switch (e) {
            error.NotFound => "cp: No such file or directory\n",
            error.IsDirectory => "cp: Is a directory\n",
            else => "cp: failed\n",
        };
        err.interface.writeAll(msg) catch {};
        err.interface.flush() catch {};
        std.process.exit(1);
    }
}

// `inline` on every helper that calls a WASI extern is mandatory: Zig 0.16's
// wasm backend emits a `(unreachable)` stub function for each extern (named
// e.g. `.Lpath_open|wasi_snapshot_preview1_bitcast_invalid`) and routes calls
// through the stub from user-defined non-`inline` helpers. The optimizer
// usually replaces stub calls with direct import calls, but the rewrite is
// fragile — see ROADMAP Stage 6 notes for the full picture.
inline fn doCopy(allocator: Allocator, src: []const u8, dest: []const u8, recursive: bool) !void {
    var probe_fd: i32 = -1;
    const oe = path_open(PREOPEN_FD, 0, src.ptr, @intCast(src.len), 0, 0, 0, 0, &probe_fd);
    if (oe == ERRNO_NOENT) return error.NotFound;
    if (oe == ERRNO_ISDIR) {
        if (!recursive) return error.IsDirectory;
        try copyTree(allocator, src, dest);
        return;
    }
    if (oe != 0) return error.OpenFailed;
    _ = fd_close(probe_fd);
    try copyFile(src, dest);
}

inline fn copyFile(src: []const u8, dest: []const u8) !void {
    var src_fd: i32 = -1;
    if (path_open(PREOPEN_FD, 0, src.ptr, @intCast(src.len), 0, 0, 0, 0, &src_fd) != 0) {
        return error.OpenFailed;
    }
    defer _ = fd_close(src_fd);

    var dst_fd: i32 = -1;
    if (path_open(
        PREOPEN_FD, 0, dest.ptr, @intCast(dest.len),
        OFLAG_CREAT | OFLAG_TRUNC, 0, 0, 0, &dst_fd,
    ) != 0) return error.OpenFailed;
    defer _ = fd_close(dst_fd);

    var buf: [4096]u8 = undefined;
    while (true) {
        var nread: u32 = 0;
        var iovs = [_]Iovec{.{.buf = &buf, .buf_len = buf.len}};
        if (fd_read(src_fd, &iovs, 1, &nread) != 0) return error.ReadFailed;
        if (nread == 0) break;
        var off: u32 = 0;
        while (off < nread) {
            var nwrote: u32 = 0;
            var wiovs = [_]ConstIovec{.{.buf = (&buf[off..]).ptr, .buf_len = nread - off}};
            if (fd_write(dst_fd, &wiovs, 1, &nwrote) != 0) return error.WriteFailed;
            if (nwrote == 0) return error.WriteFailed;
            off += nwrote;
        }
    }
}

inline fn copyTree(allocator: Allocator, root_src: []const u8, root_dest: []const u8) !void {
    var stack: std.ArrayList(Pair) = .empty;
    defer {
        for (stack.items) |p| {
            allocator.free(p.src);
            allocator.free(p.dest);
        }
        stack.deinit(allocator);
    }

    try stack.append(allocator, .{
        .src = try allocator.dupe(u8, root_src),
        .dest = try allocator.dupe(u8, root_dest),
    });

    while (stack.pop()) |pair| {
        defer {
            allocator.free(pair.src);
            allocator.free(pair.dest);
        }

        const me = path_create_directory(PREOPEN_FD, pair.dest.ptr, @intCast(pair.dest.len));
        if (me != 0 and me != ERRNO_EXIST) return error.MkdirFailed;

        var dirfd: i32 = -1;
        if (path_open(PREOPEN_FD, 0, pair.src.ptr, @intCast(pair.src.len), OFLAG_DIRECTORY, 0, 0, 0, &dirfd) != 0) {
            return error.OpenFailed;
        }

        var buf: [4096]u8 = undefined;
        var cookie: u64 = 0;
        while (true) {
            var size: u32 = 0;
            if (fd_readdir(dirfd, &buf, buf.len, cookie, &size) != 0) {
                _ = fd_close(dirfd);
                return error.ReaddirFailed;
            }
            if (size == 0) break;
            var i: usize = 0;
            var advanced = false;
            while (i + @sizeOf(Dirent) <= size) {
                const ent: *const Dirent = @ptrCast(@alignCast(&buf[i]));
                const name_start = i + @sizeOf(Dirent);
                const name_end = name_start + ent.d_namlen;
                if (name_end > size) break;
                const child_src = try joinPath(allocator, pair.src, buf[name_start..name_end]);
                const child_dest = try joinPath(allocator, pair.dest, buf[name_start..name_end]);
                if (ent.d_type == FILETYPE_DIRECTORY) {
                    try stack.append(allocator, .{.src = child_src, .dest = child_dest});
                } else {
                    defer allocator.free(child_src);
                    defer allocator.free(child_dest);
                    try copyFile(child_src, child_dest);
                }
                cookie = ent.d_next;
                i = name_end;
                advanced = true;
            }
            if (!advanced) break;
        }
        _ = fd_close(dirfd);
    }
}

const Pair = struct { src: []u8, dest: []u8 };

inline fn joinPath(allocator: Allocator, dir: []const u8, name: []const u8) ![]u8 {
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
