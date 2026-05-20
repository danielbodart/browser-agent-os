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

    _ = iter.next();

    var mode: Mode = .lines;
    var limit: u64 = 10;
    var files: std.ArrayList([]const u8) = .empty;
    defer files.deinit(allocator);

    while (iter.next()) |arg| {
        if (std.mem.eql(u8, arg, "-n") or std.mem.eql(u8, arg, "-c")) {
            mode = if (arg[1] == 'n') .lines else .bytes;
            const v = iter.next() orelse {
                err.interface.print("tail: option requires an argument -- '{c}'\n", .{arg[1]}) catch {};
                err.interface.flush() catch {};
                std.process.exit(1);
            };
            limit = std.fmt.parseInt(u64, v, 10) catch {
                err.interface.print("tail: invalid number: {s}\n", .{v}) catch {};
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
        const all = try readAll(allocator, &in.interface);
        defer allocator.free(all);
        try writeTail(&out.interface, all, mode, limit);
    } else {
        for (files.items, 0..) |path, i| {
            if (files.items.len > 1) {
                if (i > 0) try out.interface.writeAll("\n");
                try out.interface.print("==> {s} <==\n", .{path});
            }
            var file = dir.openFile(init.io, path, .{}) catch |e| {
                saw_error = true;
                err.interface.print("tail: {s}: {s}\n", .{path, errName(e)}) catch {};
                err.interface.flush() catch {};
                continue;
            };
            defer file.close(init.io);
            var fbuf: [4096]u8 = undefined;
            var reader = file.reader(init.io, &fbuf);
            const all = try readAll(allocator, &reader.interface);
            defer allocator.free(all);
            try writeTail(&out.interface, all, mode, limit);
        }
    }
    try out.interface.flush();
    if (saw_error) std.process.exit(1);
}

fn readAll(allocator: std.mem.Allocator, reader: *std.Io.Reader) ![]u8 {
    var list: std.ArrayList(u8) = .empty;
    errdefer list.deinit(allocator);
    var chunk: [4096]u8 = undefined;
    while (true) {
        const n = try reader.readSliceShort(&chunk);
        if (n == 0) break;
        try list.appendSlice(allocator, chunk[0..n]);
    }
    return list.toOwnedSlice(allocator);
}

fn writeTail(writer: *std.Io.Writer, data: []const u8, mode: Mode, limit: u64) !void {
    switch (mode) {
        .bytes => {
            const n = @as(u64, data.len);
            if (limit >= n) {
                try writer.writeAll(data);
            } else {
                try writer.writeAll(data[@intCast(n - limit)..]);
            }
        },
        .lines => {
            if (limit == 0) return;
            // Count line terminators; the last line is whatever follows the final '\n'.
            var newlines: u64 = 0;
            for (data) |b| if (b == '\n') {newlines += 1;};
            const has_trailing_partial = data.len > 0 and data[data.len - 1] != '\n';
            const total_lines = newlines + @as(u64, if (has_trailing_partial) 1 else 0);
            if (limit >= total_lines) {
                try writer.writeAll(data);
                return;
            }
            const skip = total_lines - limit;
            var seen: u64 = 0;
            var i: usize = 0;
            while (seen < skip and i < data.len) {
                if (data[i] == '\n') seen += 1;
                i += 1;
            }
            try writer.writeAll(data[i..]);
        },
    }
}

fn errName(e: anyerror) []const u8 {
    return switch (e) {
        error.FileNotFound => "No such file or directory",
        error.IsDir => "Is a directory",
        else => @errorName(e),
    };
}
