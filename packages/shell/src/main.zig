const std = @import("std");

// ---------------- ext imports (browser_agent_os_ext) ----------------

const ExtSlice = extern struct {
    ptr: [*]const u8,
    len: u32,
};

const ExtFdPair = extern struct {
    child_fd: i32,
    parent_fd: i32,
};

extern "browser_agent_os_ext" fn fd_pipe(
    read_fd_out: *i32,
    write_fd_out: *i32,
) u32;

extern "browser_agent_os_ext" fn proc_spawn(
    path_ptr: [*]const u8,
    path_len: u32,
    argv_ptr: [*]const ExtSlice,
    argv_len: u32,
    env_ptr: [*]const ExtSlice,
    env_len: u32,
    fdmap_ptr: [*]const ExtFdPair,
    fdmap_len: u32,
    pid_out: *i32,
) u32;

extern "browser_agent_os_ext" fn proc_join(
    pid: i32,
    exit_out: *i32,
) u32;

// ---------------- WASI imports we use directly ----------------

extern "wasi_snapshot_preview1" fn path_open(
    dirfd: i32,
    dirflags: u32,
    path_ptr: [*]const u8,
    path_len: u32,
    oflags: u32,
    fs_rights_base: u64,
    fs_rights_inheriting: u64,
    fdflags: u32,
    fd_out: *i32,
) u32;

extern "wasi_snapshot_preview1" fn fd_close(fd: i32) u32;

const Iovec = extern struct {
    buf: [*]u8,
    buf_len: u32,
};

extern "wasi_snapshot_preview1" fn fd_read(
    fd: i32,
    iovs_ptr: [*]const Iovec,
    iovs_len: u32,
    nread_out: *u32,
) u32;

fn readRaw(fd: i32, buf: []u8) !usize {
    var nread: u32 = 0;
    var iovs = [_]Iovec{.{.buf = buf.ptr, .buf_len = @intCast(buf.len)}};
    const e = fd_read(fd, &iovs, 1, &nread);
    if (e != 0) return error.ReadFailed;
    return @intCast(nread);
}

const PREOPEN_FD: i32 = 3;
const OFLAG_CREAT: u32 = 0x1;
const OFLAG_TRUNC: u32 = 0x8;
const FDFLAG_APPEND: u32 = 0x1;

// ---------------- shell state ----------------

const Shell = struct {
    allocator: std.mem.Allocator,
    io: std.Io,
    cwd: std.ArrayList(u8) = .empty,
    env: *std.process.Environ.Map,
    out_buf: [4096]u8 = undefined,
    err_buf: [256]u8 = undefined,

    fn init(allocator: std.mem.Allocator, io: std.Io, env: *std.process.Environ.Map) !Shell {
        var sh = Shell{
            .allocator = allocator,
            .io = io,
            .env = env,
        };
        try sh.cwd.appendSlice(allocator, "/");
        return sh;
    }

    fn deinit(self: *Shell) void {
        self.cwd.deinit(self.allocator);
    }

    fn writeOut(self: *Shell, bytes: []const u8) void {
        var w = std.Io.File.stdout().writer(self.io, &self.out_buf);
        w.interface.writeAll(bytes) catch {};
        w.interface.flush() catch {};
    }

    fn writeErr(self: *Shell, comptime fmt: []const u8, args: anytype) void {
        var w = std.Io.File.stderr().writer(self.io, &self.err_buf);
        w.interface.print(fmt, args) catch {};
        w.interface.flush() catch {};
    }
};

// ---------------- tokenizer ----------------

const TokenKind = enum { word, pipe, lt, gt, gtgt };

const Token = struct {
    kind: TokenKind,
    text: []const u8 = &.{},
};

fn tokenize(allocator: std.mem.Allocator, line: []const u8) !std.ArrayList(Token) {
    var tokens: std.ArrayList(Token) = .empty;
    errdefer tokens.deinit(allocator);

    var i: usize = 0;
    while (i < line.len) {
        const c = line[i];
        if (c == ' ' or c == '\t' or c == '\r') {
            i += 1;
            continue;
        }
        if (c == '|') {
            try tokens.append(allocator, .{.kind = .pipe});
            i += 1;
            continue;
        }
        if (c == '<') {
            try tokens.append(allocator, .{.kind = .lt});
            i += 1;
            continue;
        }
        if (c == '>') {
            if (i + 1 < line.len and line[i + 1] == '>') {
                try tokens.append(allocator, .{.kind = .gtgt});
                i += 2;
            } else {
                try tokens.append(allocator, .{.kind = .gt});
                i += 1;
            }
            continue;
        }
        // word: read until whitespace or special char
        const start = i;
        while (i < line.len) : (i += 1) {
            const x = line[i];
            if (x == ' ' or x == '\t' or x == '\r' or x == '|' or x == '<' or x == '>') break;
        }
        try tokens.append(allocator, .{.kind = .word, .text = line[start..i]});
    }
    return tokens;
}

// ---------------- AST ----------------

const RedirectKind = enum { in_file, out_trunc, out_append };

const Redirect = struct {
    kind: RedirectKind,
    target_fd: i32,
    path: []const u8,
};

const Command = struct {
    argv: std.ArrayList([]const u8) = .empty,
    redirects: std.ArrayList(Redirect) = .empty,

    pub const empty: Command = .{};

    fn deinit(self: *Command, allocator: std.mem.Allocator) void {
        self.argv.deinit(allocator);
        self.redirects.deinit(allocator);
    }
};

const Pipeline = struct {
    stages: std.ArrayList(Command) = .empty,

    pub const empty: Pipeline = .{};

    fn deinit(self: *Pipeline, allocator: std.mem.Allocator) void {
        for (self.stages.items) |*c| c.deinit(allocator);
        self.stages.deinit(allocator);
    }
};

const ParseError = error{
    EmptyCommand,
    ExpectedFile,
    UnexpectedToken,
    OutOfMemory,
};

fn parsePipeline(allocator: std.mem.Allocator, tokens: []const Token) ParseError!Pipeline {
    var pipeline: Pipeline = .empty;
    errdefer pipeline.deinit(allocator);

    var i: usize = 0;
    while (true) {
        var cmd = try parseCommand(allocator, tokens, &i);
        errdefer cmd.deinit(allocator);
        try pipeline.stages.append(allocator, cmd);
        if (i >= tokens.len) break;
        if (tokens[i].kind != .pipe) return ParseError.UnexpectedToken;
        i += 1;
    }
    return pipeline;
}

fn parseCommand(allocator: std.mem.Allocator, tokens: []const Token, i: *usize) ParseError!Command {
    var cmd: Command = .empty;
    errdefer cmd.deinit(allocator);

    while (i.* < tokens.len) {
        const t = tokens[i.*];
        switch (t.kind) {
            .word => {
                try cmd.argv.append(allocator, t.text);
                i.* += 1;
            },
            .lt, .gt, .gtgt => {
                const kind = t.kind;
                i.* += 1;
                if (i.* >= tokens.len or tokens[i.*].kind != .word) return ParseError.ExpectedFile;
                const path = tokens[i.*].text;
                i.* += 1;
                const r: Redirect = switch (kind) {
                    .lt => .{.kind = .in_file, .target_fd = 0, .path = path},
                    .gt => .{.kind = .out_trunc, .target_fd = 1, .path = path},
                    .gtgt => .{.kind = .out_append, .target_fd = 1, .path = path},
                    else => unreachable,
                };
                try cmd.redirects.append(allocator, r);
            },
            .pipe => break,
        }
    }
    if (cmd.argv.items.len == 0) return ParseError.EmptyCommand;
    return cmd;
}

// ---------------- builtin handling ----------------

fn isBuiltin(name: []const u8) bool {
    return std.mem.eql(u8, name, "cd") or
        std.mem.eql(u8, name, "pwd") or
        std.mem.eql(u8, name, "exit") or
        std.mem.eql(u8, name, "export");
}

const BuiltinResult = struct {
    exit_code: i32,
    should_exit: bool = false,
};

fn runBuiltin(sh: *Shell, argv: []const []const u8) !BuiltinResult {
    const name = argv[0];
    if (std.mem.eql(u8, name, "exit")) {
        var code: i32 = 0;
        if (argv.len >= 2) {
            code = std.fmt.parseInt(i32, argv[1], 10) catch 0;
        }
        return .{.exit_code = code, .should_exit = true};
    }
    if (std.mem.eql(u8, name, "pwd")) {
        sh.writeOut(sh.cwd.items);
        sh.writeOut("\n");
        return .{.exit_code = 0};
    }
    if (std.mem.eql(u8, name, "cd")) {
        const target = if (argv.len >= 2) argv[1] else "/";
        try setCwd(sh, target);
        return .{.exit_code = 0};
    }
    if (std.mem.eql(u8, name, "export")) {
        for (argv[1..]) |arg| {
            const eq = std.mem.indexOfScalar(u8, arg, '=') orelse continue;
            try sh.env.put(arg[0..eq], arg[eq + 1 ..]);
        }
        return .{.exit_code = 0};
    }
    unreachable;
}

fn normalizePath(allocator: std.mem.Allocator, base: []const u8, target: []const u8) ![]const u8 {
    var work: std.ArrayList(u8) = .empty;
    defer work.deinit(allocator);
    if (target.len > 0 and target[0] == '/') {
        try work.appendSlice(allocator, target);
    } else {
        try work.appendSlice(allocator, base);
        if (work.items.len == 0 or work.items[work.items.len - 1] != '/') {
            try work.append(allocator, '/');
        }
        try work.appendSlice(allocator, target);
    }

    var stack: std.ArrayList([]const u8) = .empty;
    defer stack.deinit(allocator);
    var it = std.mem.splitScalar(u8, work.items, '/');
    while (it.next()) |seg| {
        if (seg.len == 0 or std.mem.eql(u8, seg, ".")) continue;
        if (std.mem.eql(u8, seg, "..")) {
            if (stack.items.len > 0) _ = stack.pop();
            continue;
        }
        try stack.append(allocator, seg);
    }

    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);
    if (stack.items.len == 0) {
        try out.append(allocator, '/');
        return out.toOwnedSlice(allocator);
    }
    for (stack.items) |seg| {
        try out.append(allocator, '/');
        try out.appendSlice(allocator, seg);
    }
    return out.toOwnedSlice(allocator);
}

fn setCwd(sh: *Shell, target: []const u8) !void {
    const normalized = try normalizePath(sh.allocator, sh.cwd.items, target);
    defer sh.allocator.free(normalized);
    sh.cwd.clearRetainingCapacity();
    try sh.cwd.appendSlice(sh.allocator, normalized);
}

// ---------------- pipeline execution ----------------

fn resolvePath(sh: *Shell, allocator: std.mem.Allocator, p: []const u8) ![]const u8 {
    return normalizePath(allocator, sh.cwd.items, p);
}

fn openRedirect(sh: *Shell, r: Redirect) !i32 {
    var arena = std.heap.ArenaAllocator.init(sh.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const abs = try resolvePath(sh, a, r.path);

    var oflags: u32 = 0;
    var fdflags: u32 = 0;
    switch (r.kind) {
        .in_file => {},
        .out_trunc => oflags = OFLAG_CREAT | OFLAG_TRUNC,
        .out_append => {
            oflags = OFLAG_CREAT;
            fdflags = FDFLAG_APPEND;
        },
    }
    var fd_out: i32 = -1;
    const errno = path_open(
        PREOPEN_FD, 0,
        abs.ptr, @intCast(abs.len),
        oflags, 0, 0, fdflags,
        &fd_out,
    );
    if (errno != 0) return error.PathOpenFailed;
    return fd_out;
}

const EnvBundle = struct {
    slices: std.ArrayList(ExtSlice),
    backing: std.ArrayList([]u8),
};

fn buildEnvSlices(allocator: std.mem.Allocator, env: *std.process.Environ.Map) !EnvBundle {
    var slices: std.ArrayList(ExtSlice) = .empty;
    errdefer slices.deinit(allocator);
    var backing: std.ArrayList([]u8) = .empty;
    errdefer {
        for (backing.items) |b| allocator.free(b);
        backing.deinit(allocator);
    }
    const ks = env.keys();
    const vs = env.values();
    for (ks, vs) |k, v| {
        const buf = try std.fmt.allocPrint(allocator, "{s}={s}", .{k, v});
        try backing.append(allocator, buf);
        try slices.append(allocator, .{.ptr = buf.ptr, .len = @intCast(buf.len)});
    }
    return .{.slices = slices, .backing = backing};
}

fn executePipeline(sh: *Shell, pipeline: *Pipeline) !i32 {
    const allocator = sh.allocator;
    const stages = pipeline.stages.items;

    // Builtins: only honoured for a single-stage, no-redirect pipeline.
    if (stages.len == 1 and stages[0].redirects.items.len == 0 and isBuiltin(stages[0].argv.items[0])) {
        const r = try runBuiltin(sh, stages[0].argv.items);
        if (r.should_exit) std.process.exit(@intCast(r.exit_code));
        return r.exit_code;
    }

    // Allocate N-1 pipes.
    const n = stages.len;
    var pipe_reads = try allocator.alloc(i32, if (n == 0) 0 else n - 1);
    defer allocator.free(pipe_reads);
    var pipe_writes = try allocator.alloc(i32, if (n == 0) 0 else n - 1);
    defer allocator.free(pipe_writes);
    for (0..if (n == 0) 0 else n - 1) |i| {
        var r_fd: i32 = -1;
        var w_fd: i32 = -1;
        const e = fd_pipe(&r_fd, &w_fd);
        if (e != 0) return error.FdPipeFailed;
        pipe_reads[i] = r_fd;
        pipe_writes[i] = w_fd;
    }

    // Build env once for whole pipeline.
    var env_built = try buildEnvSlices(allocator, sh.env);
    defer {
        for (env_built.backing.items) |b| allocator.free(b);
        env_built.backing.deinit(allocator);
        env_built.slices.deinit(allocator);
    }

    var pids = try allocator.alloc(i32, n);
    defer allocator.free(pids);

    // Track per-stage opened file fds so we can close after spawn.
    var redirect_fds: std.ArrayList(i32) = .empty;
    defer redirect_fds.deinit(allocator);

    for (stages, 0..) |*cmd, i| {
        var stage_arena = std.heap.ArenaAllocator.init(allocator);
        defer stage_arena.deinit();
        const sa = stage_arena.allocator();

        // Build argv slices.
        var argv_slices: std.ArrayList(ExtSlice) = .empty;
        for (cmd.argv.items) |arg| {
            try argv_slices.append(sa, .{.ptr = arg.ptr, .len = @intCast(arg.len)});
        }

        // Build fdmap (default: inherit shell 0/1/2 unless wired).
        var fdmap: std.ArrayList(ExtFdPair) = .empty;
        const stdin_fd: i32 = if (i == 0) 0 else pipe_reads[i - 1];
        const stdout_fd: i32 = if (i == n - 1) 1 else pipe_writes[i];
        try fdmap.append(sa, .{.child_fd = 0, .parent_fd = stdin_fd});
        try fdmap.append(sa, .{.child_fd = 1, .parent_fd = stdout_fd});
        try fdmap.append(sa, .{.child_fd = 2, .parent_fd = 2});

        // Apply redirects (override).
        for (cmd.redirects.items) |r| {
            const fd = try openRedirect(sh, r);
            try redirect_fds.append(allocator, fd);
            // Replace existing entry for r.target_fd.
            var replaced = false;
            for (fdmap.items) |*entry| {
                if (entry.child_fd == r.target_fd) {
                    entry.parent_fd = fd;
                    replaced = true;
                    break;
                }
            }
            if (!replaced) try fdmap.append(sa, .{.child_fd = r.target_fd, .parent_fd = fd});
        }

        const path = cmd.argv.items[0];
        var pid: i32 = -1;
        const e = proc_spawn(
            path.ptr, @intCast(path.len),
            argv_slices.items.ptr, @intCast(argv_slices.items.len),
            env_built.slices.items.ptr, @intCast(env_built.slices.items.len),
            fdmap.items.ptr, @intCast(fdmap.items.len),
            &pid,
        );
        if (e != 0) {
            sh.writeErr("sh: {s}: spawn failed (errno {d})\n", .{path, e});
            // Skip joining missing pids; mark as -1.
            pids[i] = -1;
            continue;
        }
        pids[i] = pid;
    }

    // Drop shell's references to pipe ends so children's exits can close buffers cleanly.
    for (pipe_reads) |fd| _ = fd_close(fd);
    for (pipe_writes) |fd| _ = fd_close(fd);

    // Wait for each in pipeline order.
    var last_exit: i32 = 0;
    for (pids) |pid| {
        if (pid < 0) {
            last_exit = 127;
            continue;
        }
        var ec: i32 = 0;
        const e = proc_join(pid, &ec);
        if (e == 0) last_exit = ec else last_exit = 1;
    }

    // Close redirect file fds.
    for (redirect_fds.items) |fd| _ = fd_close(fd);

    return last_exit;
}

// ---------------- REPL ----------------

const LineReader = struct {
    pending: std.ArrayList(u8) = .empty,
    eof: bool = false,

    fn next(self: *LineReader, allocator: std.mem.Allocator) !?[]u8 {
        var chunk: [256]u8 = undefined;
        while (true) {
            if (std.mem.indexOfScalar(u8, self.pending.items, '\n')) |idx| {
                const line = try allocator.dupe(u8, self.pending.items[0..idx]);
                const rest = self.pending.items[idx + 1 ..];
                std.mem.copyForwards(u8, self.pending.items[0..rest.len], rest);
                self.pending.shrinkRetainingCapacity(rest.len);
                return line;
            }
            if (self.eof) {
                if (self.pending.items.len == 0) return null;
                const line = try allocator.dupe(u8, self.pending.items);
                self.pending.clearRetainingCapacity();
                return line;
            }
            const n = try readRaw(0, &chunk);
            if (n == 0) {
                self.eof = true;
                continue;
            }
            try self.pending.appendSlice(allocator, chunk[0..n]);
        }
    }

    fn deinit(self: *LineReader, allocator: std.mem.Allocator) void {
        self.pending.deinit(allocator);
    }
};

fn runLine(sh: *Shell, line: []const u8) !i32 {
    const trimmed = std.mem.trim(u8, line, " \t\r\n");
    if (trimmed.len == 0) return 0;

    var tokens = try tokenize(sh.allocator, trimmed);
    defer tokens.deinit(sh.allocator);
    if (tokens.items.len == 0) return 0;

    var pipeline = parsePipeline(sh.allocator, tokens.items) catch |e| {
        sh.writeErr("sh: parse error: {s}\n", .{@errorName(e)});
        return 2;
    };
    defer pipeline.deinit(sh.allocator);

    return executePipeline(sh, &pipeline);
}

const Args = struct { interactive: bool };

fn parseArgs(init: std.process.Init, allocator: std.mem.Allocator) !Args {
    var iter = try init.minimal.args.iterateAllocator(allocator);
    defer iter.deinit();
    _ = iter.next(); // program name
    var interactive = false;
    while (iter.next()) |a| {
        if (std.mem.eql(u8, a, "-i")) interactive = true;
    }
    return .{ .interactive = interactive };
}

fn writePrompt(sh: *Shell) void {
    sh.writeOut(sh.cwd.items);
    sh.writeOut("$ ");
}

pub fn main(init: std.process.Init) !void {
    const allocator = std.heap.wasm_allocator;
    const args = try parseArgs(init, allocator);

    var sh = try Shell.init(allocator, init.io, init.environ_map);
    defer sh.deinit();

    var reader: LineReader = .{};
    defer reader.deinit(allocator);

    var last_exit: i32 = 0;
    while (true) {
        if (args.interactive) writePrompt(&sh);
        const maybe = try reader.next(allocator);
        if (maybe == null) break;
        const line = maybe.?;
        defer allocator.free(line);
        last_exit = try runLine(&sh, line);
    }

    std.process.exit(@intCast(last_exit));
}
