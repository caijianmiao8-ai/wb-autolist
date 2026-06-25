#!/usr/bin/env perl
# One-shot: convert hardcoded dark-only color utilities into a light default
# plus a `dark:` override, preserving any variant prefix (hover:/focus:/etc).
# Safe: s///ge scans left-to-right and never re-scans inserted text.
use strict;
use warnings;

my %light = (
  'text-white'       => 'text-slate-900',
  'text-slate-100'   => 'text-slate-900',
  'text-slate-200'   => 'text-slate-800',
  'text-slate-300'   => 'text-slate-700',
  'text-slate-400'   => 'text-slate-500',
  'text-slate-600'   => 'text-slate-400',
  'text-emerald-200' => 'text-emerald-700',
  'text-emerald-300' => 'text-emerald-600',
  'text-emerald-400' => 'text-emerald-600',
  'text-rose-200'    => 'text-rose-700',
  'text-rose-300'    => 'text-rose-600',
  'text-rose-400'    => 'text-rose-600',
  'text-amber-200'   => 'text-amber-700',
  'text-amber-300'   => 'text-amber-600',
  'text-sky-300'     => 'text-sky-600',
  'bg-white/5'       => 'bg-slate-900/[0.04]',
  'bg-white/[0.02]'  => 'bg-slate-900/[0.02]',
  'bg-black/20'      => 'bg-slate-900/[0.05]',
  'border-white/10'  => 'border-slate-900/10',
  'border-white/15'  => 'border-slate-900/15',
  'border-white/30'  => 'border-slate-900/30',
);

my $alt = join('|', map { quotemeta }
                    sort { length($b) <=> length($a) } keys %light);

local $/;
while (my $file = shift @ARGV) {
  open my $fh, '<', $file or die "open $file: $!";
  my $src = <$fh>;
  close $fh;
  $src =~ s{(?<![\w:/-])((?:[a-z-]+:)*)($alt)(?![\w])}{
    my ($pre, $tok) = ($1, $2);
    "$pre$light{$tok} dark:$pre$tok"
  }ge;
  open my $out, '>', $file or die "write $file: $!";
  print $out $src;
  close $out;
  print "themed: $file\n";
}
