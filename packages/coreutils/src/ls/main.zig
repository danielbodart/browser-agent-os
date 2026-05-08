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

const PREOPEN_FD: i32 = 3;
const OFLAG_DIRECTORY: u32 = 0x2;

// WASI dirent: 24-byte header followed by `d_namlen` bytes of name, packed.
const Dirent = extern struct {
    d_next: u64,
    d_ino: u64,
    d_namlen: u32,
    d_type: u8,
    _padding: [3]u8,
};

pub fn main(init: std.process.Init) !void {
    const allocator = std.heap.wasm_allocator;
    var iter = try init.minimal.args.iterateAllocator(allocator);
    defer iter.deinit();
    _ = iter.next(); // program name

    var wbuf: [4096]u8 = undefined;
    var out = std.Io.File.stdout().writer(init.io, &wbuf);
    var ebuf: [256]u8 = undefined;
    var err = std.Io.File.stderr().writer(init.io, &ebuf);

    const target = iter.next() orelse "/";

    var dirfd: i32 = -1;
    const e = path_open(
        PREOPEN_FD,
        0,
        target.ptr,
        @intCast(target.len),
        OFLAG_DIRECTORY,
        0,
        0,
        0,
        &dirfd,
    );
    if (e != 0) {
        err.interface.print("ls: {s}: cannot open directory\n", .{target}) catch {};
        err.interface.flush() catch {};
        std.process.exit(1);
    }
    defer _ = fd_close(dirfd);

    var buf: [4096]u8 = undefined;
    var cookie: u64 = 0;
    while (true) {
        var size: u32 = 0;
        const re = fd_readdir(dirfd, &buf, buf.len, cookie, &size);
        if (re != 0) {
            err.interface.print("ls: readdir failed\n", .{}) catch {};
            err.interface.flush() catch {};
            std.process.exit(1);
        }
        if (size == 0) break;
        var i: usize = 0;
        var advanced = false;
        while (i + @sizeOf(Dirent) <= size) {
            const ent: *const Dirent = @ptrCast(@alignCast(&buf[i]));
            const name_start = i + @sizeOf(Dirent);
            const name_end = name_start + ent.d_namlen;
            if (name_end > size) break;
            try out.interface.writeAll(buf[name_start..name_end]);
            try out.interface.writeAll("\n");
            cookie = ent.d_next;
            i = name_end;
            advanced = true;
        }
        if (!advanced) break;
    }
    try out.interface.flush();
}
