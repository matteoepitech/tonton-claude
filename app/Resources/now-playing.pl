#!/usr/bin/perl
# Runs mediaremote-adapter (app/Vendor/mediaremote-adapter) for Tonton Claude's Music mode, and ends it when Tonton goes
# away. The adapter's stream only stops on a signal, and an app that crashes or is killed sends none: it would read Now
# Playing for nobody until its next write failed. So Tonton holds this process's standard input open, and never writes to
# it. A second perl process waits for it to close, which happens however Tonton ends, and then stops the adapter.
# Usage: now-playing.pl ADAPTER_SCRIPT FRAMEWORK_PATH FUNCTION [OPTIONS...]

use strict;
use warnings;
use POSIX ();

my $adapter = shift @ARGV;
die "Usage: now-playing.pl ADAPTER_SCRIPT FRAMEWORK_PATH FUNCTION [OPTIONS...]\n" unless defined $adapter && @ARGV >= 2;
die "No adapter at $adapter\n" unless -r $adapter;

my $stream = $$;
my $watcher = fork();
die "Can't start the watcher: $!\n" unless defined $watcher;
if ($watcher == 0) {
  # The watcher keeps none of the stream's output open: Tonton reads it to its end once the adapter is gone.
  open(STDOUT, '>', '/dev/null');
  open(STDERR, '>', '/dev/null');
  my $buffer;
  1 while sysread(STDIN, $buffer, 512);
  # The adapter stops on SIGTERM. Once it has quit by itself, this process belongs to launchd and there is nothing to stop.
  kill('TERM', $stream) if getppid() == $stream;
  POSIX::_exit(0);
}

# The adapter runs in this process, whose pid Tonton knows, as if perl had been given its script and the arguments left.
close(STDIN);
do $adapter;
die $@ if $@;
exit 0;
