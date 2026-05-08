const std = @import("std");

pub fn main(init: std.process.Init) !void {
    const allocator = std.heap.wasm_allocator;
    var iter = try init.minimal.args.iterateAllocator(allocator);
    defer iter.deinit();

    var buf: [4096]u8 = undefined;
    var out = std.Io.File.stdout().writer(init.io, &buf);

    _ = iter.next(); // program name
    var first = true;
    while (iter.next()) |arg| {
        if (!first) try out.interface.writeAll(" ");
        try out.interface.writeAll(arg);
        first = false;
    }
    try out.interface.writeAll("\n");
    try out.interface.flush();
}
