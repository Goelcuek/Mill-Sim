; *********************************************************************
; FIDIA — the same job in the other idiom
;
;   >   in front of a line means "do it now"
;   ;   is a remark, and so is ( )
;   ORIGIN n  selects a work offset, where a Fanuc writes G54
;   RTCP ON   holds the tool tip still while the rotaries move
;   G0/G2/G3  last one block; a bare block of coordinates is a feed
;   R         is written negative for the arc a Fanuc writes positive
;   G92       reads DX/DY/DZ — which way the tool points — and works
;             out the rotary positions itself. G93 goes back.
;   RG 50 1   sets a register; $IF (RG 50 = 1) tests one.
; *********************************************************************

; *********** DEFINE TOOLS ***********
; The block every Fidia program opens with: it fills in the control's own
; tool table. The simulator cuts with the assembly in the pot the program
; calls for, so these are read and passed over — the Summary page says how
; many. TDIAM asking a question inside an expression still gets answered.
TTYP 2 1
TDIAM__1 2 10.0
TRADIUS__1 2 5.0
TCUTNR__1 2 2
TMAXSP 2 20000

RG 50 1.00

ORIGIN 1
>G90 G21
>G17
RTCP OF
RTCP ON

>M06 T0.02
>M03 S6000
>M08

; ---- a slot, to show G0 lasting exactly one block --------------------
>G0 X-30 Y0 Z10
F900
X-30 Y0 Z-3
X30 Y0 Z-3
>G0 Z10

; ---- an arc, radius written negative ---------------------------------
>G0 X-20 Y22 Z10
F700
X-20 Y22 Z-2.5
G03 X20 Y22 R-25
>G0 Z10

; ---- vector mode: the block says where the tool points ---------------
;      A register the operator sets decides whether this one runs.
$IF (RG 50 = 0) $GOTO DONE

G92
>G0 X0 Y-22 Z20
F500
; tip the tool over up here, where nothing can be touched on the way
X0 Y-22 Z20 DX0 DY-0.4226 DZ0.9063
X0 Y-22 Z2 DX0 DY-0.4226 DZ0.9063
X0 Y-22 Z-7 DX0 DY-0.4226 DZ0.9063
X0 Y-22 Z2 DX0 DY-0.4226 DZ0.9063
G93
>G0 Z20

DONE:
RTCP OF
>M05
>M09
M30
