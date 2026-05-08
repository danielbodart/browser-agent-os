const std = @import("std");

pub fn main(init: std.process.Init) !void {
    var rbuf: [4096]u8 = undefined;
    var wbuf: [4096]u8 = undefined;
    var in = std.Io.File.stdin().reader(init.io, &rbuf);
    var out = std.Io.File.stdout().writer(init.io, &wbuf);

    var chunk: [4096]u8 = undefined;
    while (true) {
        const n = try in.interface.readSliceShort(&chunk);
        if (n == 0) break;
        try out.interface.writeAll(chunk[0..n]);
    }
    try out.interface.flush();
}
