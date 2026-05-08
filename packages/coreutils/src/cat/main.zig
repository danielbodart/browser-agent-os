const std = @import("std");

pub fn main(init: std.process.Init) !void {
    const allocator = std.heap.wasm_allocator;
    var iter = try init.minimal.args.iterateAllocator(allocator);
    defer iter.deinit();

    var wbuf: [4096]u8 = undefined;
    var out = std.Io.File.stdout().writer(init.io, &wbuf);
    var ebuf: [256]u8 = undefined;
    var err = std.Io.File.stderr().writer(init.io, &ebuf);

    _ = iter.next(); // program name

    var any_args = false;
    var saw_error = false;
    const dir = std.Io.Dir.cwd();
    while (iter.next()) |arg| {
        any_args = true;
        if (std.mem.eql(u8, arg, "-")) {
            try copyStdin(init, &out.interface);
            continue;
        }
        var file = dir.openFile(init.io, arg, .{}) catch |e| {
            saw_error = true;
            err.interface.print("cat: {s}: {s}\n", .{arg, errName(e)}) catch {};
            err.interface.flush() catch {};
            continue;
        };
        defer file.close(init.io);
        var fbuf: [4096]u8 = undefined;
        var reader = file.reader(init.io, &fbuf);
        try copyAll(&reader.interface, &out.interface);
    }

    if (!any_args) {
        try copyStdin(init, &out.interface);
    }
    try out.interface.flush();
    if (saw_error) std.process.exit(1);
}

fn copyStdin(init: std.process.Init, out: *std.Io.Writer) !void {
    var rbuf: [4096]u8 = undefined;
    var in = std.Io.File.stdin().reader(init.io, &rbuf);
    try copyAll(&in.interface, out);
}

fn copyAll(reader: *std.Io.Reader, writer: *std.Io.Writer) !void {
    var chunk: [4096]u8 = undefined;
    while (true) {
        const n = try reader.readSliceShort(&chunk);
        if (n == 0) break;
        try writer.writeAll(chunk[0..n]);
    }
}

fn errName(e: anyerror) []const u8 {
    return switch (e) {
        error.FileNotFound => "No such file or directory",
        error.IsDir => "Is a directory",
        error.AccessDenied => "Permission denied",
        else => @errorName(e),
    };
}
