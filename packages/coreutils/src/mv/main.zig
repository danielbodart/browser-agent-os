const std = @import("std");

extern "wasi_snapshot_preview1" fn path_rename(
    fromfd: i32,
    from_ptr: [*]const u8,
    from_len: u32,
    tofd: i32,
    to_ptr: [*]const u8,
    to_len: u32,
) u32;

const PREOPEN_FD: i32 = 3;

pub fn main(init: std.process.Init) !void {
    const allocator = std.heap.wasm_allocator;
    var iter = try init.minimal.args.iterateAllocator(allocator);
    defer iter.deinit();

    var ebuf: [256]u8 = undefined;
    var err = std.Io.File.stderr().writer(init.io, &ebuf);

    _ = iter.next();

    const from = iter.next() orelse {
        err.interface.writeAll("mv: missing source operand\n") catch {};
        err.interface.flush() catch {};
        std.process.exit(1);
    };
    const to = iter.next() orelse {
        err.interface.writeAll("mv: missing destination operand\n") catch {};
        err.interface.flush() catch {};
        std.process.exit(1);
    };
    if (iter.next()) |_| {
        err.interface.writeAll("mv: too many arguments\n") catch {};
        err.interface.flush() catch {};
        std.process.exit(1);
    }

    const e = path_rename(
        PREOPEN_FD, from.ptr, @intCast(from.len),
        PREOPEN_FD, to.ptr, @intCast(to.len),
    );
    if (e != 0) {
        err.interface.print("mv: {s} -> {s}: errno {d}\n", .{from, to, e}) catch {};
        err.interface.flush() catch {};
        std.process.exit(1);
    }
}
