const std = @import("std");

pub fn main(init: std.process.Init) !void {
    var buf: [4096]u8 = undefined;
    var out = std.Io.File.stdout().writer(init.io, &buf);

    const keys = init.environ_map.keys();
    const values = init.environ_map.values();
    for (keys, values) |k, v| {
        try out.interface.writeAll(k);
        try out.interface.writeAll("=");
        try out.interface.writeAll(v);
        try out.interface.writeAll("\n");
    }
    try out.interface.flush();
}
