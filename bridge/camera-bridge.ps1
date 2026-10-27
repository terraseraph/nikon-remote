# Camera bridge: a long-running process that speaks raw PTP to a USB camera through the
# Windows Portable Devices (WPD) API. Node talks to it over stdin/stdout, one JSON object per line.
#
# Request:  {"id":1,"op":4097,"params":[0,0],"dir":"none|read|write","data":"<base64>","file":"<path>"}
#   dir=read  returns the data phase as base64, or writes it to "file" if given.
#   dir=write sends base64 "data" as the data phase.
# Response: {"id":1,"code":8193,"data":"<base64>"}  or  {"id":1,"error":"..."}

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;

[StructLayout(LayoutKind.Sequential)]
public struct PropertyKey { public Guid fmtid; public uint pid;
  public PropertyKey(Guid g, uint p) { fmtid = g; pid = p; } }

[StructLayout(LayoutKind.Explicit, Size = 24)]
public struct PropVariant { [FieldOffset(0)] public ushort vt; [FieldOffset(8)] public uint ulVal; }

// Only the methods we call are typed; the rest are vtable placeholders and must stay in order.
[ComImport, Guid("6848f6f2-3155-4f86-b6f5-263eeeab3143"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IPortableDeviceValues {
  void GetCount(); void GetAt(); void SetValue(); void GetValue();
  void SetStringValue(ref PropertyKey key, [MarshalAs(UnmanagedType.LPWStr)] string v);
  void GetStringValue(ref PropertyKey key, [MarshalAs(UnmanagedType.LPWStr)] out string v);
  void SetUnsignedIntegerValue(ref PropertyKey key, uint v);
  void GetUnsignedIntegerValue(ref PropertyKey key, out uint v);
  void SetSignedIntegerValue(); void GetSignedIntegerValue();
  void SetUnsignedLargeIntegerValue(ref PropertyKey key, ulong v);
  void GetUnsignedLargeIntegerValue(ref PropertyKey key, out ulong v);
  void SetSignedLargeIntegerValue(); void GetSignedLargeIntegerValue();
  void SetFloatValue(); void GetFloatValue();
  void SetErrorValue(); void GetErrorValue(ref PropertyKey key, out int v);
  void SetKeyValue(); void GetKeyValue(); void SetBoolValue(); void GetBoolValue();
  void SetIUnknownValue(); void GetIUnknownValue();
  void SetGuidValue(ref PropertyKey key, ref Guid v);
  void GetGuidValue();
  void SetBufferValue(ref PropertyKey key, [MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 2)] byte[] v, uint size);
  void GetBufferValue(ref PropertyKey key, out IntPtr v, out uint size);
  void SetIPortableDeviceValuesValue(); void GetIPortableDeviceValuesValue();
  void SetIPortableDevicePropVariantCollectionValue(ref PropertyKey key, IPortableDevicePropVariantCollection v);
}

[ComImport, Guid("89b2e422-4f1b-4316-bcef-a44afea83eb3"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IPortableDevicePropVariantCollection {
  void GetCount(); void GetAt(); void Add(ref PropVariant v);
}

[ComImport, Guid("625e2df8-6392-4cf0-9ad1-3cfa5f17775c"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IPortableDevice {
  void Open([MarshalAs(UnmanagedType.LPWStr)] string id, IPortableDeviceValues clientInfo);
  void SendCommand(uint flags, IPortableDeviceValues parameters, out IPortableDeviceValues results);
  void Content(); void Capabilities(); void Cancel(); void Close();
}

public class PtpDevice {
  static readonly Guid Common = new Guid("F0422A9C-5DC8-4440-B5BD-5DF28835658A");
  static readonly Guid MtpExt = new Guid("4D545058-1A2E-4106-A357-771E0819FC56");
  static readonly Guid Client = new Guid("204D9F0C-2292-4080-9F42-40664E70F859");

  // WPD_COMMAND_MTP_EXT_* command ids
  const uint ExecNoData = 12, ExecRead = 13, ExecWrite = 14, ReadData = 15, WriteData = 16, EndTransfer = 17;

  static PropertyKey K(Guid g, uint pid) { return new PropertyKey(g, pid); }
  static readonly PropertyKey CmdCategory = K(Common, 1001), CmdId = K(Common, 1002), HResult = K(Common, 1003);
  static readonly PropertyKey OpCode = K(MtpExt, 1001), OpParams = K(MtpExt, 1002), RespCode = K(MtpExt, 1003),
    Context = K(MtpExt, 1006), TotalSize = K(MtpExt, 1007), BytesToRead = K(MtpExt, 1008), BytesRead = K(MtpExt, 1009),
    BytesToWrite = K(MtpExt, 1010), BytesWritten = K(MtpExt, 1011), TransferData = K(MtpExt, 1012), OptimalSize = K(MtpExt, 1013);

  static T Create<T>(string clsid) { return (T)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid(clsid))); }
  static IPortableDeviceValues NewValues() { return Create<IPortableDeviceValues>("0c15d503-d017-47ce-9016-7b3f978721cc"); }

  IPortableDevice dev;

  public PtpDevice(string deviceId) {
    dev = Create<IPortableDevice>("728a21c5-3d9e-48d7-9810-864848f0f404");
    var client = NewValues();
    var k = K(Client, 2); client.SetStringValue(ref k, "local_camera_nikon");
    dev.Open(deviceId, client);
  }

  public void Close() { dev.Close(); }

  IPortableDeviceValues Send(uint cmd, IPortableDeviceValues p) {
    var cat = MtpExt; var k = CmdCategory; p.SetGuidValue(ref k, ref cat);
    k = CmdId; p.SetUnsignedIntegerValue(ref k, cmd);
    IPortableDeviceValues r; dev.SendCommand(0, p, out r);
    int hr; k = HResult; r.GetErrorValue(ref k, out hr);
    if (hr != 0) Marshal.ThrowExceptionForHR(hr);
    return r;
  }

  static IPortableDeviceValues OpValues(uint op, uint[] args) {
    var p = NewValues();
    var k = OpCode; p.SetUnsignedIntegerValue(ref k, op);
    var coll = Create<IPortableDevicePropVariantCollection>("08a99e2f-6d6d-4b80-af5a-baf2bcbe4cb9");
    foreach (var a in args) { var pv = new PropVariant { vt = 19, ulVal = a }; coll.Add(ref pv); }
    k = OpParams; p.SetIPortableDevicePropVariantCollectionValue(ref k, coll);
    return p;
  }

  uint Finish(string ctx) {
    var p = NewValues(); var k = Context; p.SetStringValue(ref k, ctx);
    var r = Send(EndTransfer, p);
    uint code; k = RespCode; r.GetUnsignedIntegerValue(ref k, out code); return code;
  }

  public uint Exec(uint op, uint[] args) {
    var r = Send(ExecNoData, OpValues(op, args));
    uint code; var k = RespCode; r.GetUnsignedIntegerValue(ref k, out code); return code;
  }

  public uint Read(uint op, uint[] args, Stream sink) {
    var r = Send(ExecRead, OpValues(op, args));
    string ctx; var k = Context; r.GetStringValue(ref k, out ctx);
    ulong total; k = TotalSize; r.GetUnsignedLargeIntegerValue(ref k, out total);
    uint chunk = 256 * 1024;
    try { uint opt; k = OptimalSize; r.GetUnsignedIntegerValue(ref k, out opt); if (opt > 0) chunk = Math.Max(opt, chunk); } catch { }
    ulong done = 0;
    while (done < total) {
      uint want = (uint)Math.Min((ulong)chunk, total - done);
      var p = NewValues();
      k = Context; p.SetStringValue(ref k, ctx);
      k = BytesToRead; p.SetUnsignedIntegerValue(ref k, want);
      k = TransferData; p.SetBufferValue(ref k, new byte[want], want);
      var rr = Send(ReadData, p);
      uint got; k = BytesRead; rr.GetUnsignedIntegerValue(ref k, out got);
      IntPtr buf; uint size; k = TransferData; rr.GetBufferValue(ref k, out buf, out size);
      var bytes = new byte[got]; Marshal.Copy(buf, bytes, 0, (int)got); Marshal.FreeCoTaskMem(buf);
      sink.Write(bytes, 0, bytes.Length);
      if (got == 0) break;
      done += got;
    }
    return Finish(ctx);
  }

  public uint Write(uint op, uint[] args, byte[] data) {
    var p = OpValues(op, args);
    var k = TotalSize; p.SetUnsignedLargeIntegerValue(ref k, (ulong)data.Length);
    var r = Send(ExecWrite, p);
    string ctx; k = Context; r.GetStringValue(ref k, out ctx);
    var w = NewValues();
    k = Context; w.SetStringValue(ref k, ctx);
    k = BytesToWrite; w.SetUnsignedIntegerValue(ref k, (uint)data.Length);
    k = TransferData; w.SetBufferValue(ref k, data, (uint)data.Length);
    Send(WriteData, w);
    return Finish(ctx);
  }
}
'@

# USB vendor IDs of camera makers. Phones and music players are WPD devices too, so they're skipped.
$CameraVendors = @(
  '04B0'  # Nikon
  '04A9'  # Canon
  '054C'  # Sony
  '04CB'  # Fujifilm
  '07B4'  # Olympus
  '33A2'  # OM System
  '04DA'  # Panasonic
  '25FB'  # Ricoh / Pentax
  '0A17'  # Pentax
  '1A98'  # Leica
  '1003'  # Sigma
)

function Find-CameraId {
  $dev = Get-PnpDevice -PresentOnly -Class WPD -ErrorAction SilentlyContinue |
    Where-Object { $_.InstanceId -match '^USB\\VID_([0-9A-F]{4})' -and $CameraVendors -contains $Matches[1] } |
    Select-Object -First 1
  if (-not $dev) { return $null }
  [pscustomobject]@{
    Name = $dev.FriendlyName
    Path = '\\?\' + ($dev.InstanceId -replace '\\', '#').ToLower() + '#{6ac27878-a6fa-4155-ba85-f98f491d4f33}'
  }
}

function Reply([string]$json) { [Console]::Out.WriteLine($json); [Console]::Out.Flush() }
function Esc([string]$s) { $s -replace '\\', '\\' -replace '"', '\"' -replace "`r|`n", ' ' }

$cam = Find-CameraId
$ptp = $null
if ($cam) {
  try { $ptp = [PtpDevice]::new($cam.Path); Reply ('{"ready":true,"name":"' + (Esc $cam.Name) + '"}') }
  catch { Reply ('{"ready":false,"error":"' + (Esc $_.Exception.Message) + '"}') }
} else {
  Reply '{"ready":false,"error":"No camera found over USB"}'
}

while ($null -ne ($line = [Console]::In.ReadLine())) {
  if (-not $line.Trim()) { continue }
  $req = $line | ConvertFrom-Json
  try {
    if (-not $ptp) { throw 'Camera not connected' }
    $args32 = [uint32[]]@($req.params | ForEach-Object { [uint32]$_ })
    switch ($req.dir) {
      'read' {
        if ($req.file) {
          $fs = [IO.File]::Create($req.file)
          try { $code = $ptp.Read([uint32]$req.op, $args32, $fs) } finally { $fs.Dispose() }
          Reply ('{"id":' + $req.id + ',"code":' + $code + '}')
        } else {
          $ms = [IO.MemoryStream]::new()
          $code = $ptp.Read([uint32]$req.op, $args32, $ms)
          Reply ('{"id":' + $req.id + ',"code":' + $code + ',"data":"' + [Convert]::ToBase64String($ms.ToArray()) + '"}')
        }
      }
      'write' {
        $code = $ptp.Write([uint32]$req.op, $args32, [Convert]::FromBase64String($req.data))
        Reply ('{"id":' + $req.id + ',"code":' + $code + '}')
      }
      default {
        $code = $ptp.Exec([uint32]$req.op, $args32)
        Reply ('{"id":' + $req.id + ',"code":' + $code + '}')
      }
    }
  } catch {
    Reply ('{"id":' + $req.id + ',"error":"' + (Esc $_.Exception.Message) + '"}')
  }
}
if ($ptp) { $ptp.Close() }
