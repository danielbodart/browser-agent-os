const std = @import("std");

const Counts = struct {
    lines: u64 = 0,
    words: u64 = 0,
    bytes: u64 = 0,
};

const Flags = struct {
    lines: bool = false,
    words: bool = false,
    bytes: bool = false,

    fn anySet(self: Flags) bool {
        return self.lines or self.words or self.bytes;
    }

    fn defaultIfUnset(self: Flags) Flags {
        if (self.anySet()) return self;
        return .{ .lines = true, .words = true, .bytes = true };
    }
};

pub fn main(init: std.process.Init) !void {
    const allocator = std.heap.wasm_allocator;
    var iter = try init.minimal.args.iterateAllocator(allocator);
    defer iter.deinit();

    var wbuf: [4096]u8 = undefined;
    var out = std.Io.File.stdout().writer(init.io, &wbuf);
    var ebuf: [256]u8 = undefined;
    var err = std.Io.File.stderr().writer(init.io, &ebuf);

    _ = iter.next(); // program name

    var flags: Flags = .{};
    var files: std.ArrayList([]const u8) = .empty;
    defer files.deinit(allocator);

    while (iter.next()) |arg| {
        if (arg.len > 1 and arg[0] == '-' and !std.mem.eql(u8, arg, "-")) {
            for (arg[1..]) |c| switch (c) {
                'l' => flags.lines = true,
                'w' => flags.words = true,
                'c' => flags.bytes = true,
                else => {
                    err.interface.print("wc: invalid option -- '{c}'\n", .{c}) catch {};
                    err.interface.flush() catch {};
                    std.process.exit(1);
                },
            };
        } else {
            try files.append(allocator, arg);
        }
    }
    const active = flags.defaultIfUnset();

    var saw_error = false;
    var total: Counts = .{};

    const dir = std.Io.Dir.cwd();
    if (files.items.len == 0) {
        var rbuf: [4096]u8 = undefined;
        var in = std.Io.File.stdin().reader(init.io, &rbuf);
        const c = try countReader(&in.interface);
        try writeRow(&out.interface, active, c, null);
    } else {
        for (files.items) |path| {
            const c = countFile(init, dir, path) catch |e| {
                saw_error = true;
                err.interface.print("wc: {s}: {s}\n", .{path, errName(e)}) catch {};
                err.interface.flush() catch {};
                continue;
            };
            try writeRow(&out.interface, active, c, path);
            total.lines += c.lines;
            total.words += c.words;
            total.bytes += c.bytes;
        }
        if (files.items.len > 1) try writeRow(&out.interface, active, total, "total");
    }
    try out.interface.flush();
    if (saw_error) std.process.exit(1);
}

fn countFile(init: std.process.Init, dir: std.Io.Dir, path: []const u8) !Counts {
    var file = try dir.openFile(init.io, path, .{});
    defer file.close(init.io);
    var fbuf: [4096]u8 = undefined;
    var reader = file.reader(init.io, &fbuf);
    return countReader(&reader.interface);
}

fn countReader(reader: *std.Io.Reader) !Counts {
    var c: Counts = .{};
    var chunk: [4096]u8 = undefined;
    var in_word = false;
    while (true) {
        const n = try reader.readSliceShort(&chunk);
        if (n == 0) break;
        c.bytes += n;
        for (chunk[0..n]) |b| {
            if (b == '\n') c.lines += 1;
            const ws = b == ' ' or b == '\t' or b == '\n' or b == '\r';
            if (ws) {
                in_word = false;
            } else if (!in_word) {
                in_word = true;
                c.words += 1;
            }
        }
    }
    return c;
}

fn writeRow(writer: *std.Io.Writer, flags: Flags, c: Counts, name: ?[]const u8) !void {
    var first = true;
    if (flags.lines) {
        if (!first) try writer.writeAll(" ");
        try writer.print("{d:>7}", .{c.lines});
        first = false;
    }
    if (flags.words) {
        if (!first) try writer.writeAll(" ");
        try writer.print("{d:>7}", .{c.words});
        first = false;
    }
    if (flags.bytes) {
        if (!first) try writer.writeAll(" ");
        try writer.print("{d:>7}", .{c.bytes});
        first = false;
    }
    if (name) |n| {
        try writer.writeAll(" ");
        try writer.writeAll(n);
    }
    try writer.writeAll("\n");
}

fn errName(e: anyerror) []const u8 {
    return switch (e) {
        error.FileNotFound => "No such file or directory",
        error.IsDir => "Is a directory",
        else => @errorName(e),
    };
}
