; SIEMENS 840D SL - SWIVEL PLANE, DRILLING CYCLES, TOOLS BY NAME
; The side-hole job again, written the way a Siemens is: tools chosen by
; name before M6, the facing passes as one labelled section run again with
; REPEAT, CYCLE800 to swing the head onto the right face, MCALL CYCLE83 to
; peck both side holes and CYCLE81 for the one from the top.
; Stock 120 x 90 x 40 at X40-X160, zero at the table centre and the top of
; the stock. Loading it sets the machine to the head-table and to Siemens.
G17 G71 G40 G90 G54
TRAFOOF
CYCLE800()
DIAMOF
CYCLE832(0.02, _ROUGH, 1)

; ---- face the top: one pass, then the same section twice more -----------
T="50 face mill"
M6
S3000 M3
R1 = -30
G0 X10 Y=R1 Z25
PASS:
G0 X10 Y=R1 Z5
G1 Z-1 F1500
G1 X190 F3000
G0 Z5
R1 = R1 + 30
ENDLABEL:
REPEAT PASS P=2
G0 Z60

; ---- two holes into the right face, through a swivelled plane ------------
T="10 flat"
M6
S6000 M3
G0 X190 Y0
; Axis by axis, X then Y then Z (57): 90 about Y, the plane's origin on the
; face at the holes' height. Retract in Z first, and swing the head.
; _DIR +1 takes the higher B, B90 with the table at C0; -1 would be B-90
; with the table turned half round, the face then on the far side.
CYCLE800(1, "", 0, 57, 160, 0, -15, 0, 90, 0, 0, 0, 0, 1, 100, 1)
G0 X0 Y0 Z20
F300
MCALL CYCLE83(10, 0, 2, -15, , -6, , 2, 0, 0, 1, 0)
X0 Y0
X0 Y20
MCALL
G0 Z30
; Stand the head up again, then take the plane away.
CYCLE800(1, "", 0, 57, 0, 0, 0, 0, 0, 0, 0, 0, 0, -1, 100, 1)
CYCLE800()

; ---- the hole from the top, into the first --------------------------------
G0 X150 Y0 Z25
F300
CYCLE81(10, 0, 2, -20)
G75 FP=1 Z1
M5
M30
