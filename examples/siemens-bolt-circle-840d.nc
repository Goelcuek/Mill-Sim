; SIEMENS 840D - THE SAME JOB, THE OTHER SPELLING
; R parameters, round brackets for arithmetic, symbols for the
; comparisons, ENDWHILE to close a loop and a named label to jump to.
; Set Machine > Macros > Reads like to Siemens 840D and this runs;
; read as Fanuc it is nonsense, which is the point.
G17 G21 G40 G90

; ---- the part ----------------------------------------------------
R10 = 70.       ; plate length X
R11 = 70.       ; plate width Y
R12 = 4.        ; facing depth of cut
R20 = 22.       ; bolt circle radius
R21 = 6         ; holes
R22 = 10.       ; hole depth

; ---- face the top ------------------------------------------------
T1 M06
S3000 M03
G54 G00 X=-R10 / 2 - 30 Y0 Z10.
G00 Z=-R12 + 4.
G01 Z0 F400
G01 X=R10 / 2 + 30 F1200
G00 Z10.

; ---- a pocket, roughed in rings ----------------------------------
T3 M06
S5200 M03
G00 X0 Y0 Z5.
R1 = 0.
WHILE R1 < R12
  R1 = R1 + 2.
  IF R1 > R12 GOTOF DEEPEST
  GOTOF CUT
DEEPEST:
  R1 = R12
CUT:
  G01 Z=-R1 F250
  R2 = 5.
  WHILE R2 <= 18.
    G01 X=R2 Y0 F900
    G02 X=R2 Y0 I=-R2 J0
    R2 = R2 + 6.
  ENDWHILE
  G00 X0 Y0
ENDWHILE
G00 Z25.

; ---- the bolt circle ---------------------------------------------
T7 M06
S4000 M03
G00 Z10.
FOR R3 = 0 TO R21 - 1
  R4 = 360. * R3 / R21
  G00 X=R20 * COS(R4) Y=R20 * SIN(R4)
  G00 Z2.
  G01 Z=-R22 F180
  G00 Z2.
ENDFOR

G00 Z50.
M05
M30
