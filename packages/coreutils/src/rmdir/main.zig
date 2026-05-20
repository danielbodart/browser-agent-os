const std = @import("std");

extern "wasi_snapshot_preview1" fn path_remove_directory(
    dirfd: i32,
    path_ptr: [*]const u8,
    path_len: u32,
) u32;

const PREOPEN_FD: i32 = 3;

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
        const e = path_remove_directory(PREOPEN_FD, path.ptr, @intCast(path.len));
        if (e != 0) {
            saw_error = true;
            err.interface.print("rmdir: {s}: errno {d}\n", .{path, e}) catch {};
            err.interface.flush() catch {};
        }
    }
    if (!any) {
        err.interface.writeAll("rmdir: missing operand\n") catch {};
        err.interface.flush() catch {};
        std.process.exit(1);
    }
    if (saw_error) std.process.exit(1);
}
