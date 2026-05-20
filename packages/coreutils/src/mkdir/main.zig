const std = @import("std");

extern "wasi_snapshot_preview1" fn path_create_directory(
    dirfd: i32,
    path_ptr: [*]const u8,
    path_len: u32,
) u32;

const PREOPEN_FD: i32 = 3;
const ERRNO_EXIST: u32 = 20;

pub fn main(init: std.process.Init) !void {
    const allocator = std.heap.wasm_allocator;
    var iter = try init.minimal.args.iterateAllocator(allocator);
    defer iter.deinit();

    var ebuf: [256]u8 = undefined;
    var err = std.Io.File.stderr().writer(init.io, &ebuf);

    _ = iter.next();

    var parents = false;
    var any_path = false;
    var saw_error = false;

    while (iter.next()) |arg| {
        if (std.mem.eql(u8, arg, "-p")) {
            parents = true;
            continue;
        }
        any_path = true;
        const result = if (parents) makeWithParents(arg) else makeOne(arg);
        if (result) |_| {} else |_| {
            saw_error = true;
            err.interface.print("mkdir: {s}: cannot create directory\n", .{arg}) catch {};
            err.interface.flush() catch {};
        }
    }
    if (!any_path) {
        err.interface.writeAll("mkdir: missing operand\n") catch {};
        err.interface.flush() catch {};
        std.process.exit(1);
    }
    if (saw_error) std.process.exit(1);
}

fn makeOne(path: []const u8) !void {
    const e = path_create_directory(PREOPEN_FD, path.ptr, @intCast(path.len));
    if (e != 0) return error.MkdirFailed;
}

fn makeWithParents(path: []const u8) !void {
    if (path.len == 0) return;
    var i: usize = 1;
    while (i <= path.len) {
        if (i < path.len and path[i] != '/') {
            i += 1;
            continue;
        }
        const segment = path[0..i];
        if (segment.len > 0) {
            const e = path_create_directory(PREOPEN_FD, segment.ptr, @intCast(segment.len));
            if (e != 0 and e != ERRNO_EXIST) return error.MkdirFailed;
        }
        i += 1;
    }
}
