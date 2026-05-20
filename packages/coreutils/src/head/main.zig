const std = @import("std");

const Mode = enum { lines, bytes };

pub fn main(init: std.process.Init) !void {
    const allocator = std.heap.wasm_allocator;
    var iter = try init.minimal.args.iterateAllocator(allocator);
    defer iter.deinit();

    var wbuf: [4096]u8 = undefined;
    var out = std.Io.File.stdout().writer(init.io, &wbuf);
    var ebuf: [256]u8 = undefined;
    var err = std.Io.File.stderr().writer(init.io, &ebuf);

    _ = iter.next(); // program name

    var mode: Mode = .lines;
    var limit: u64 = 10;
    var files: std.ArrayList([]const u8) = .empty;
    defer files.deinit(allocator);

    while (iter.next()) |arg| {
        if (std.mem.eql(u8, arg, "-n") or std.mem.eql(u8, arg, "-c")) {
            mode = if (arg[1] == 'n') .lines else .bytes;
            const v = iter.next() orelse {
                err.interface.print("head: option requires an argument -- '{c}'\n", .{arg[1]}) catch {};
                err.interface.flush() catch {};
                std.process.exit(1);
            };
            limit = std.fmt.parseInt(u64, v, 10) catch {
                err.interface.print("head: invalid number: {s}\n", .{v}) catch {};
                err.interface.flush() catch {};
                std.process.exit(1);
            };
        } else {
            try files.append(allocator, arg);
        }
    }

    var saw_error = false;
    const dir = std.Io.Dir.cwd();
    if (files.items.len == 0) {
        var rbuf: [4096]u8 = undefined;
        var in = std.Io.File.stdin().reader(init.io, &rbuf);
        try copyHead(&in.interface, &out.interface, mode, limit);
    } else {
        for (files.items, 0..) |path, i| {
            if (files.items.len > 1) {
                if (i > 0) try out.interface.writeAll("\n");
                try out.interface.print("==> {s} <==\n", .{path});
            }
            var file = dir.openFile(init.io, path, .{}) catch |e| {
                saw_error = true;
                err.interface.print("head: {s}: {s}\n", .{path, errName(e)}) catch {};
                err.interface.flush() catch {};
                continue;
            };
            defer file.close(init.io);
            var fbuf: [4096]u8 = undefined;
            var reader = file.reader(init.io, &fbuf);
            try copyHead(&reader.interface, &out.interface, mode, limit);
        }
    }
    try out.interface.flush();
    if (saw_error) std.process.exit(1);
}

fn copyHead(reader: *std.Io.Reader, writer: *std.Io.Writer, mode: Mode, limit: u64) !void {
    var chunk: [4096]u8 = undefined;
    var seen: u64 = 0;
    while (seen < limit) {
        const n = try reader.readSliceShort(&chunk);
        if (n == 0) break;
        switch (mode) {
            .bytes => {
                const remaining = limit - seen;
                const take = if (n < remaining) n else @as(usize, @intCast(remaining));
                try writer.writeAll(chunk[0..take]);
                seen += take;
            },
            .lines => {
                var i: usize = 0;
                while (i < n and seen < limit) {
                    const start = i;
                    while (i < n and chunk[i] != '\n') i += 1;
                    if (i < n) {
                        i += 1;
                        seen += 1;
                    }
                    try writer.writeAll(chunk[start..i]);
                }
            },
        }
    }
}

fn errName(e: anyerror) []const u8 {
    return switch (e) {
        error.FileNotFound => "No such file or directory",
        error.IsDir => "Is a directory",
        else => @errorName(e),
    };
}
