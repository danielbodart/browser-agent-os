const std = @import("std");

const Bin = struct {
    name: []const u8,
};

const bins = [_]Bin{
    .{ .name = "echo" },
    .{ .name = "cat" },
};

pub fn build(b: *std.Build) void {
    const target = b.resolveTargetQuery(.{
        .cpu_arch = .wasm32,
        .os_tag = .wasi,
    });
    const optimize = b.standardOptimizeOption(.{});

    for (bins) |bin| {
        const root = b.createModule(.{
            .root_source_file = b.path(b.fmt("src/{s}/main.zig", .{bin.name})),
            .target = target,
            .optimize = optimize,
        });
        const exe = b.addExecutable(.{
            .name = bin.name,
            .root_module = root,
        });
        b.installArtifact(exe);
    }
}
