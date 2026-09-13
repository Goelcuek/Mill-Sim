(MACRO FAMILY OF PARTS - FANUC MACRO B)
(One program, three sizes of the same plate: the numbers at the top)
(are the drawing, and everything below works itself out from them.)
G17 G21 G40 G49 G80 G90

(---- the part ----------------------------------------------------)
#100 = 90.     (plate length X)
#101 = 60.     (plate width  Y)
#102 = 6.      (pocket depth)
#104 = 20.     (pocket radius)
#110 = 4.      (bolt holes)
#111 = 30.     (bolt circle radius)
#112 = 12.     (hole depth)

(---- face the top ------------------------------------------------)
T1 M06
S3000 M03
G54 G00 X[-#100 / 2 - 30] Y0 Z10.
G43 H01 Z5.
G01 Z0 F400
G01 X[#100 / 2 + 30] F1200
G00 Z10.

(---- rough the round pocket, a ring at a time --------------------)
T3 M06
S5200 M03
G00 X0 Y0 Z10.
G43 H03 Z2.
#1 = 0.                                    (depth so far)
WHILE [#1 LT #102] DO 1
  #1 = #1 + 2.                             (2 mm a pass)
  IF [#1 GT #102] THEN #1 = #102
  G01 Z[-#1] F250
  #2 = 6.                                  (first ring, from the middle)
  WHILE [#2 LE #104] DO 2
    G01 X#2 Y0 F900
    G02 X#2 Y0 I[-#2] J0
    G01 X[#2 + 6.] Y0
    #2 = #2 + 6.
  END 2
  G00 Z2.
  G00 X0 Y0
END 1
G00 Z25.

(---- the bolt circle, through the plate --------------------------)
T7 M06
S4000 M03
G00 X#111 Y0 Z10.
G43 H07 Z5.
#4 = 0
WHILE [#4 LT #110] DO 1
  #5 = 360. * #4 / #110
  #6 = #111 * COS[#5]
  #7 = #111 * SIN[#5]
  G00 X#6 Y#7
  G83 Z[-#112] R2. Q3. F180
  G80
  #4 = #4 + 1
END 1

(---- and a note of what it made ----------------------------------)
#120 = #100 * #101                         (plate area, mm2)
#121 = #110                                (holes drilled)
G00 Z50.
M05
M30
