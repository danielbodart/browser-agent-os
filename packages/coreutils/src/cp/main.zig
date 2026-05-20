const std = @import("std");

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

const Iovec = extern struct { buf: [*]u8, buf_len: u32 };
const ConstIovec = extern struct { buf: [*]const u8, buf_len: u32 };

extern "wasi_snapshot_preview1" fn fd_read(
    fd: i32,
    iovs_ptr: [*]const Iovec,
    iovs_len: u32,
    nread_out: *u32,
) u32;

extern "wasi_snapshot_preview1" fn fd_write(
    fd: i32,
    iovs_ptr: [*]const ConstIovec,
    iovs_len: u32,
    nwritten_out: *u32,
) u32;

const PREOPEN_FD: i32 = 3;
const OFLAG_CREAT: u32 = 0x1;
const OFLAG_TRUNC: u32 = 0x8;

pub fn main(init: std.process.Init) !void {
    var iter = try init.minimal.args.iterateAllocator(std.heap.wasm_allocator);
    defer iter.deinit();

    var ebuf: [256]u8 = undefined;
    var err = std.Io.File.stderr().writer(init.io, &ebuf);

    _ = iter.next();
    const src = iter.next() orelse "";
    const dest = iter.next() orelse "";

    // Linear flow: open src, open dst, copy, close, report.
    // (Helper functions that call Suspending imports tickle a Zig 0.16+JSPI
    // codegen bug that traps on the exit path, so inline everything here.)
    var src_fd: i32 = -1;
    const oe = path_open(PREOPEN_FD, 0, src.ptr, @intCast(src.len), 0, 0, 0, 0, &src_fd);
    var dst_fd: i32 = -1;
    var de: u32 = 1;
    if (oe == 0) {
        de = path_open(PREOPEN_FD, 0, dest.ptr, @intCast(dest.len), OFLAG_CREAT | OFLAG_TRUNC, 0, 0, 0, &dst_fd);
    }

    var copy_ok = true;
    if (oe == 0 and de == 0) {
        var buf: [4096]u8 = undefined;
        outer: while (true) {
            var nread: u32 = 0;
            var iovs = [_]Iovec{.{.buf = &buf, .buf_len = buf.len}};
            if (fd_read(src_fd, &iovs, 1, &nread) != 0) {
                copy_ok = false;
                break;
            }
            if (nread == 0) break;
            var off: u32 = 0;
            while (off < nread) {
                var nwrote: u32 = 0;
                var wiovs = [_]ConstIovec{.{.buf = (&buf[off..]).ptr, .buf_len = nread - off}};
                if (fd_write(dst_fd, &wiovs, 1, &nwrote) != 0 or nwrote == 0) {
                    copy_ok = false;
                    break :outer;
                }
                off += nwrote;
            }
        }
        _ = fd_close(dst_fd);
        _ = fd_close(src_fd);
    } else if (oe == 0) {
        _ = fd_close(src_fd);
    }

    if (oe != 0 or de != 0 or !copy_ok) {
        err.interface.writeAll("cp: failed\n") catch {};
        err.interface.flush() catch {};
        std.process.exit(1);
    }
}
