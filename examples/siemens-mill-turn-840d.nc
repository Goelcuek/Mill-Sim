; SIEMENS 840D SL - TURNING ON THE TABLE (MILL-TURN)
; A Ø80 bar stood on the trunnion's table. CYCLE800 with "DREHEN" makes
; the C table the lathe spindle and the tool in the milling spindle stands
; still; X is a diameter (DIAMON), Z runs up the bar, G96 holds the cutting
; speed at whatever diameter the tool is on and LIMS caps the table's rpm.
; Loading it sets the machine to the A/C trunnion and to Siemens.
G17 G90 G54 G71

; ---- outside turning ------------------------------------------------------
T11 M6
CYCLE800(1, "DREHEN", 0, 57, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1)
DIAMON
G18
G96 S180 M3 LIMS=800
G95 F0.25
; Face a millimetre off the top, through the centre.
G0 X90 Z5
G0 Z-1
G1 X-1.6
G0 Z5
; Rough the outside to Ø70, 30 long, in two passes.
G0 X76 Z2
G1 Z-30
G1 X82
G0 Z2
G0 X70
G1 Z-30
G1 X82
G0 Z2
; Finish: a chamfer into Ø68, the diameter, the shoulder.
G0 X62 Z1
G1 X68 Z-2 F0.15
G1 Z-30
G1 X78
G1 X82 Z-32
G0 X100 Z20

; ---- a groove -------------------------------------------------------------
T13 M6
G96 S120 M3 LIMS=600
G95 F0.05
G0 X74 Z-17
G1 X60
G0 X74
G0 X100 Z20

; ---- a thread, M68 x 1.5, plunged in four passes --------------------------
T14 M6
G97 S400 M3
G95 F1.5
G0 X72 Z4
G0 X67.4
G1 Z-12
G0 X72
G0 Z4
G0 X66.9
G1 Z-12
G0 X72
G0 Z4
G0 X66.5
G1 Z-12
G0 X72
G0 Z4
G0 X66.2
G1 Z-12
G0 X72
G0 X100 Z20

; ---- back to milling ------------------------------------------------------
M5
DIAMOF
G17
CYCLE800()
M30
