; SIEMENS 840D - THE SAME JOB, THE OTHER SPELLING
; Variables of the program's own, declared with DEF and used by name;
; R parameters for the counting; round brackets for arithmetic,
; symbols for the comparisons, ENDWHILE to close a loop and a named
; label to jump to. Set Machine > Macros > Reads like to Siemens 840D
; and this runs; read as Fanuc it is nonsense, which is the point.
; Program > Variables follows every one of them through the run.

; ---- the part ----------------------------------------------------
; DEF comes first, before anything else the program does.
DEF REAL LENGTH=70, WIDTH=70  ; plate, X and Y
DEF REAL FACE=4               ; facing depth of cut
DEF REAL PCD_R=22             ; bolt circle radius
DEF INT HOLES=6
DEF REAL HOLE_Z=10            ; hole depth
DEF INT RINGS=0               ; rings cut, counted as they go
G17 G21 G40 G90

; ---- face the top ------------------------------------------------
T1 M06
S3000 M03
G54 G00 X=-LENGTH / 2 - 30 Y0 Z10.
G00 Z=-FACE + 4.
G01 Z0 F400
G01 X=LENGTH / 2 + 30 F1200
G00 Z10.

; ---- a pocket, roughed in rings ----------------------------------
T3 M06
S5200 M03
G00 X0 Y0 Z5.
R1 = 0.
WHILE R1 < FACE
  R1 = R1 + 2.
  IF R1 > FACE GOTOF DEEPEST
  GOTOF CUT
DEEPEST:
  R1 = FACE
CUT:
  G01 Z=-R1 F250
  R2 = 5.
  WHILE R2 <= 18.
    G01 X=R2 Y0 F900
    G02 X=R2 Y0 I=-R2 J0
    RINGS = RINGS + 1
    R2 = R2 + 6.
  ENDWHILE
  G00 X0 Y0
ENDWHILE
G00 Z25.

; ---- the bolt circle ---------------------------------------------
T7 M06
S4000 M03
G00 Z10.
FOR R3 = 0 TO HOLES - 1
  R4 = 360. * R3 / HOLES
  G00 X=PCD_R * COS(R4) Y=PCD_R * SIN(R4)
  G00 Z2.
  G01 Z=-HOLE_Z F180
  G00 Z2.
ENDFOR

G00 Z50.
M05
M30
