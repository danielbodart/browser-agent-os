const std = @import("std");

pub fn main(init: std.process.Init) !void {
    var buf: [4096]u8 = undefined;
    var out = std.Io.File.stdout().writer(init.io, &buf);
    const cwd = init.environ_map.get("PWD") orelse "/";
    try out.interface.writeAll(cwd);
    try out.interface.writeAll("\n");
    try out.interface.flush();
}
