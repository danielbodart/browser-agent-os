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

const PREOPEN_FD: i32 = 3;
const OFLAG_CREAT: u32 = 0x1;

pub fn main(init: std.process.Init) !void {
    const allocator = std.heap.wasm_allocator;
    var iter = try init.minimal.args.iterateAllocator(allocator);
    defer iter.deinit();

    var ebuf: [256]u8 = undefined;
    var err = std.Io.File.stderr().writer(init.io, &ebuf);

    _ = iter.next();

    var any = false;
    var saw_error = false;
    while (iter.next()) |path| {
        any = true;
        var fd: i32 = -1;
        const e = path_open(
            PREOPEN_FD, 0,
            path.ptr, @intCast(path.len),
            OFLAG_CREAT, 0, 0, 0,
            &fd,
        );
        if (e != 0) {
            saw_error = true;
            err.interface.print("touch: {s}: errno {d}\n", .{path, e}) catch {};
            err.interface.flush() catch {};
            continue;
        }
        _ = fd_close(fd);
    }
    if (!any) {
        err.interface.writeAll("touch: missing operand\n") catch {};
        err.interface.flush() catch {};
        std.process.exit(1);
    }
    if (saw_error) std.process.exit(1);
}
